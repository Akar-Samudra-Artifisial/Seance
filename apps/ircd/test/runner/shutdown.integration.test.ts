import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { FAKE_KIRO_BIN, ManualClock, closeAllFixtures, startIntegration } from "./integration.js";
import type { IntegrationFixture, IrcTestClient, LogRecord } from "./integration.js";

// Task 22.8: graceful shutdown against the real Fake_Agent process (Req 11.1,
// 11.3, 11.4, 11.6, 11.7, 11.8, 11.9).
//
// `runner.shutdown()` is called explicitly here (the fixture also calls it in
// teardown; shutdown is idempotent, so the second call returns the same promise
// and runs the sequence once). The sequence waits for each cancelled session's
// Cooldown on the injected ManualClock, so a background pump keeps virtual time
// moving while `shutdown()` is awaited — exactly like the exorcism test's
// afterEach pump, but driven during the call under test as well.

const run = promisify(execFile);
const TEST_TIMEOUT_MS = 30_000;
const UNTIL_TIMEOUT_MS = 15_000;

/** Turn 1 (matched on "plumbing") streams a chunk then blocks on a gate: a turn that stays in flight. */
const GATED_SCRIPT = {
  turns: [{ match: "plumbing", steps: [{ chunk: "digging" }, { gate: "hold" }] }],
} as const;

interface Rpc {
  readonly method: string;
  readonly params: Readonly<Record<string, unknown>>;
}

interface World {
  readonly fx: IntegrationFixture;
  readonly clock: ManualClock;
  readonly op: IrcTestClient;
  readonly scratch: string;
  readonly stdinLog: string;
}

let world: World | undefined;
let scratchDirs: string[] = [];

afterEach(async () => {
  const clock = world?.clock;
  world = undefined;
  // The fixture's teardown calls shutdown() too; it may still wait on a Cooldown.
  const pump = clock === undefined ? undefined : setInterval(() => clock.advance(1_000), 5);
  try {
    await closeAllFixtures();
  } finally {
    if (pump !== undefined) clearInterval(pump);
    const dirs = scratchDirs;
    scratchDirs = [];
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  }
}, TEST_TIMEOUT_MS);

const yieldLoop = (): Promise<void> => new Promise((res) => setImmediate(res));

/** Waits for `cond`, yielding to the event loop (no wall-clock sleep). */
async function until(w: World, what: string, cond: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + UNTIL_TIMEOUT_MS;
  for (;;) {
    if (await cond()) return;
    if (Date.now() > deadline) {
      const tail = w.fx.logs
        .filter((l) => !l.msg.startsWith("acp"))
        .slice(-15)
        .map((l) => `${l.level} ${l.msg} ${JSON.stringify(l.fields ?? {})}`)
        .join("\n  ");
      throw new Error(`timed out waiting for ${what}; last runner logs:\n  ${tail}`);
    }
    await yieldLoop();
  }
}

/**
 * Awaits `work` while pumping the ManualClock, so the shutdown sequence's
 * Cooldown waits (1000 ms each) elapse without wall-clock time. Returns the
 * value `work` resolves to.
 */
async function withClockPump<T>(w: World, work: Promise<T>): Promise<T> {
  const pump = setInterval(() => w.clock.advance(1_000), 2);
  try {
    return await work;
  } finally {
    clearInterval(pump);
  }
}

async function setup(): Promise<World> {
  const scratch = await mkdtemp(join(tmpdir(), "seance-shutdown-"));
  scratchDirs.push(scratch);
  const stdinLog = join(scratch, "agent-stdin.log");
  const wrapper = join(scratch, "kiro-tee");
  // tee every JSON-RPC line the runner sends so the test can count session/cancel.
  await writeFile(stdinLog, "");
  await writeFile(wrapper, `#!/bin/sh\ntee -a '${stdinLog}' | '${FAKE_KIRO_BIN}' "$@"\n`, { mode: 0o755 });
  const clock = new ManualClock();
  const fx = await startIntegration({ clock, script: GATED_SCRIPT, env: { SEANCE_KIRO_BIN: wrapper } });
  const op = await fx.connectClient("op");
  world = { fx, clock, op, scratch, stdinLog };
  return world;
}

async function requests(w: World, method: string): Promise<readonly Rpc[]> {
  const text = await readFile(w.stdinLog, "utf8");
  const out: Rpc[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) continue;
    const rec = parsed as Record<string, unknown>;
    if (rec["method"] !== method) continue;
    const params = rec["params"];
    out.push({ method, params: typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {} });
  }
  return out;
}

const promptCount = async (w: World): Promise<number> => (await requests(w, "session/prompt")).length;

const joinedCount = (w: World, channel: string): number =>
  w.fx.logs.filter((l) => l.msg === "agent joined channel" && l.fields?.["channel"] === channel).length;

const exits = (w: World): readonly LogRecord[] => w.fx.logs.filter((l) => l.msg === "acp exit");
const spawns = (w: World): readonly LogRecord[] => w.fx.logs.filter((l) => l.msg === "acp spawn");

const wtPath = (w: World, name: string): string => join(w.fx.workspaces, name);

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run("git", [...args], { cwd });
  return stdout.trim();
}

/** A commit plus uncommitted edits and an untracked file in a worktree. */
async function dirty(dir: string, tag: string): Promise<string> {
  await writeFile(join(dir, `${tag}-committed.txt`), "kept\n");
  await git(dir, ["add", "-A"]);
  await git(dir, [
    "-c", "user.name=Seance Test",
    "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false",
    "commit", "--quiet", "-m", `${tag} commit`,
  ]);
  const head = await git(dir, ["rev-parse", "HEAD"]);
  await writeFile(join(dir, "README.md"), "scribbled by the agent\n");
  await writeFile(join(dir, `${tag}-untracked.txt`), "junk\n");
  return head;
}

/** op creates `channel`, invites coder, waits until the session is open and gives it +o. */
async function summon(w: World, channel: string): Promise<void> {
  const before = joinedCount(w, channel);
  await w.op.join(channel);
  w.op.send(`INVITE coder ${channel}`);
  await w.op.waitFor(/^:\S+ 341 /);
  await until(w, `coder to join ${channel}`, () => joinedCount(w, channel) > before);
  w.op.send(`MODE ${channel} +o coder`);
  await w.op.waitFor(new RegExp(`MODE ${channel} \\+o coder`));
}

/** Sends a prompt and waits until the Fake_Agent has received it. */
async function prompt(w: World, channel: string, text: string): Promise<void> {
  const seen = await promptCount(w);
  w.op.send(`PRIVMSG ${channel} :coder ${text}`);
  await until(w, `session/prompt for "${text}"`, async () => (await promptCount(w)) > seen);
}

async function namesOf(w: World, channel: string): Promise<string> {
  w.op.send(`NAMES ${channel}`);
  return w.op.waitFor(/^:\S+ 353 /);
}

describe("graceful shutdown (agent-runner Req 11)", () => {
  it(
    "cancels the in-flight turn, waits for Cooldown, terminates the process and leaves zero timers and processes",
    async () => {
      const w = await setup();
      await summon(w, "#haunt");
      await prompt(w, "#haunt", "dig the plumbing");
      // Coder is present and a turn is in flight.
      expect(await namesOf(w, "#haunt")).toContain("coder");
      expect(await requests(w, "session/cancel")).toHaveLength(0);
      expect(spawns(w)).toHaveLength(1);
      expect(exits(w)).toHaveLength(0);

      // The agent leaves on its own QUIT when the virtual client is closed (step 6).
      const agentGone = w.op.waitFor(/^:coder!\S+ QUIT/);

      const report = await withClockPump(w, w.fx.runner.shutdown());

      // Req 11.7: nothing left to keep Node alive.
      expect(report.errors).toEqual([]);
      expect(report.remainingTimers).toBe(0);
      expect(report.remainingProcesses).toBe(0);

      // Req 11.3: the prompting session was cancelled exactly once before termination.
      expect(await requests(w, "session/cancel")).toHaveLength(1);
      // Req 11.4: the agent process received SIGTERM and exited.
      await until(w, "agent process exit", () => exits(w).length === 1);
      const exit = exits(w)[0];
      expect(exit?.fields?.["signal"]).toBe("SIGTERM");

      // Req 11.6: the agent left its channel.
      await agentGone;
      expect(await namesOf(w, "#haunt")).not.toContain("coder");

      expect(w.fx.logs.filter((l) => l.level === "error")).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "with no session prompting, terminates the idle process and reports zero remaining timers and processes",
    async () => {
      const w = await setup();
      await summon(w, "#haunt");
      expect(spawns(w)).toHaveLength(1);

      const report = await withClockPump(w, w.fx.runner.shutdown());

      expect(report.errors).toEqual([]);
      expect(report.remainingTimers).toBe(0);
      expect(report.remainingProcesses).toBe(0);
      // Req 11.4: idle session still ends with SIGTERM; Req 11.3 sends no cancel.
      expect(await requests(w, "session/cancel")).toHaveLength(0);
      await until(w, "agent process exit", () => exits(w).length === 1);
      expect(exits(w)[0]?.fields?.["signal"]).toBe("SIGTERM");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "is idempotent: a second shutdown returns the same report and runs the sequence once",
    async () => {
      const w = await setup();
      await summon(w, "#haunt");
      await prompt(w, "#haunt", "dig the plumbing");

      const first = await withClockPump(w, w.fx.runner.shutdown());
      // Second call: no further work (Req 11.8), returns an identical report.
      const second = await withClockPump(w, w.fx.runner.shutdown());

      expect(second).toEqual(first);
      expect(first.remainingTimers).toBe(0);
      expect(first.remainingProcesses).toBe(0);
      // Exactly one cancel and one exit despite two shutdown() calls.
      expect(await requests(w, "session/cancel")).toHaveLength(1);
      expect(exits(w)).toHaveLength(1);
      expect(spawns(w)).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "refuses new invitations once shutting down and starts no further process",
    async () => {
      const w = await setup();
      await summon(w, "#haunt");

      await withClockPump(w, w.fx.runner.shutdown());
      const spawnsAfterShutdown = spawns(w).length;

      // Req 11.1/11.2: a new invite during/after shutdown is refused (resolver → false,
      // so the ircd answers 401) and spawns nothing.
      await w.op.join("#crypt");
      w.op.send("INVITE coder #crypt");
      await w.op.waitFor(/^:\S+ 401 \S+ coder /);
      expect(await w.op.expectNone(/^:\S+ 341 /)).toBe(true);
      expect(joinedCount(w, "#crypt")).toBe(0);
      expect(spawns(w)).toHaveLength(spawnsAfterShutdown);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "leaves every worktree untouched: uncommitted work survives shutdown",
    async () => {
      const w = await setup();
      await summon(w, "#haunt");
      await prompt(w, "#haunt", "dig the plumbing");
      const dir = wtPath(w, "haunt");
      const head = await dirty(dir, "haunt");

      const report = await withClockPump(w, w.fx.runner.shutdown());
      expect(report.remainingProcesses).toBe(0);

      // Req 11.9: HEAD, the committed file, the edit and the untracked file are all intact.
      expect(await git(dir, ["rev-parse", "HEAD"])).toBe(head);
      expect(await readFile(join(dir, "README.md"), "utf8")).toBe("scribbled by the agent\n");
      expect(await readFile(join(dir, "haunt-committed.txt"), "utf8")).toBe("kept\n");
      expect(await exists(join(dir, "haunt-untracked.txt"))).toBe(true);
      expect(await git(w.fx.repo.path, ["branch", "--list", "seance/haunt"])).toContain("seance/haunt");
    },
    TEST_TIMEOUT_MS,
  );
});
