import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { VirtualClient } from "../../src/virtual-client.js";
import { FAKE_KIRO_BIN, ManualClock, closeAllFixtures, startIntegration } from "./integration.js";
import type { IntegrationFixture, IrcTestClient } from "./integration.js";

// Exorcism (Req 9.1-9.7, 9.10, 9.11) against the real Fake_Agent process.
// The Fake_Agent is started through a tee wrapper so the test can read every
// JSON-RPC request the runner sent it (session/prompt, session/cancel).

const run = promisify(execFile);
const TEST_TIMEOUT_MS = 30_000;
const UNTIL_TIMEOUT_MS = 15_000;
const MAX_ADVANCE_MS = 30_000;

/** Turn 1 (matched on "plumbing") streams a chunk and then blocks on a gate: a turn that stays in flight. */
const SCRIPT = {
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
  // Shutdown waits for session Cooldowns on the ManualClock; keep it moving.
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

/**
 * Waits for `cond`, yielding to the event loop (no wall-clock sleep). With
 * `advance` the ManualClock moves 100 ms per turn so the runner's Cooldown and
 * poll timers fire deterministically.
 */
async function until(w: World, what: string, cond: () => boolean | Promise<boolean>, advance = false): Promise<void> {
  const deadline = Date.now() + UNTIL_TIMEOUT_MS;
  let advanced = 0;
  let lastAdvance = 0;
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
    // Bounded: unlimited advancing would trip the 120 s hung-agent watchdog while git runs.
    if (advance && advanced < MAX_ADVANCE_MS && Date.now() - lastAdvance >= 5) {
      w.clock.advance(100);
      advanced += 100;
      lastAdvance = Date.now();
    }
    await yieldLoop();
  }
}

async function setup(): Promise<World> {
  const scratch = await mkdtemp(join(tmpdir(), "seance-exorcism-"));
  scratchDirs.push(scratch);
  const stdinLog = join(scratch, "agent-stdin.log");
  const wrapper = join(scratch, "kiro-tee");
  await writeFile(stdinLog, "");
  await writeFile(wrapper, `#!/bin/sh\ntee -a '${stdinLog}' | '${FAKE_KIRO_BIN}' "$@"\n`, { mode: 0o755 });
  const clock = new ManualClock();
  const fx = await startIntegration({ clock, script: SCRIPT, env: { SEANCE_KIRO_BIN: wrapper } });
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

const promptTexts = async (w: World): Promise<readonly string[]> =>
  (await requests(w, "session/prompt")).map((r) => JSON.stringify(r.params["prompt"]));

const joinedCount = (w: World, channel: string): number =>
  w.fx.logs.filter((l) => l.msg === "agent joined channel" && l.fields?.["channel"] === channel).length;

const exorcisedCount = (w: World, channel: string): number =>
  w.fx.logs.filter((l) => l.msg === "exorcism finished" && l.fields?.["channel"] === channel).length;

const wtPath = (w: World, name: string): string => join(w.fx.workspaces, name);

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
  const seen = (await promptTexts(w)).length;
  w.op.send(`PRIVMSG ${channel} :coder ${text}`);
  await until(w, `session/prompt for "${text}"`, async () => (await promptTexts(w)).length > seen);
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await run("git", [...args], { cwd });
  return stdout.trim();
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/** One commit plus uncommitted edits and an untracked file in a worktree. */
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

async function expectReset(dir: string, tag: string, head: string): Promise<void> {
  expect(await git(dir, ["rev-parse", "HEAD"])).toBe(head);
  expect(await readFile(join(dir, "README.md"), "utf8")).toBe("# fixture\n");
  expect(await readFile(join(dir, `${tag}-committed.txt`), "utf8")).toBe("kept\n");
  expect(await exists(join(dir, `${tag}-untracked.txt`))).toBe(false);
}

function agentClient(w: World, nick: string): VirtualClient {
  const client = w.fx.server.ctx.connections.getByNick(nick);
  if (client === undefined || !("dispatch" in client)) throw new Error(`${nick} is not a virtual client`);
  return client as VirtualClient;
}

async function namesOf(w: World, channel: string): Promise<string> {
  w.op.send(`NAMES ${channel}`);
  return w.op.waitFor(/^:\S+ 353 /);
}

describe("exorcism (agent-runner Req 9)", () => {
  it(
    "/kick during a turn: one session/cancel, worktree reset, branch and log kept, session released",
    async () => {
      const w = await setup();
      await summon(w, "#haunt");
      await prompt(w, "#haunt", "dig the plumbing");
      const dir = wtPath(w, "haunt");
      const head = await dirty(dir, "haunt");
      expect(await requests(w, "session/cancel")).toHaveLength(0);

      w.op.send("KICK #haunt coder :begone");
      await w.op.waitFor(/KICK #haunt coder/);
      await until(w, "exorcism to finish", () => exorcisedCount(w, "#haunt") === 1, true);

      // Req 9.4(a): exactly one cancel, for the one session in flight.
      expect(await requests(w, "session/cancel")).toHaveLength(1);
      // Req 9.4(c): reset to the last commit; Req 9.7: the branch and its commit survive.
      await expectReset(dir, "haunt", head);
      expect(await git(w.fx.repo.path, ["branch", "--list", "seance/haunt"])).toContain("seance/haunt");
      // The kick already removed the Agent, so the leave of Req 9.6 does not apply.
      expect(await namesOf(w, "#haunt")).not.toContain("coder");
      expect(w.op.lines.some((l) => l.includes("has been exorcised"))).toBe(false);
      expect(w.fx.logs.filter((l) => l.level === "error")).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps the channel log: a later invite resumes with a summary of the old lines",
    async () => {
      const w = await setup();
      await summon(w, "#haunt");
      await prompt(w, "#haunt", "dig the plumbing");
      w.op.send("KICK #haunt coder :begone");
      await until(w, "exorcism to finish", () => exorcisedCount(w, "#haunt") === 1, true);

      w.op.send("INVITE coder #haunt");
      await until(w, "coder to rejoin", () => joinedCount(w, "#haunt") === 2);
      await until(w, "resume prompt", async () => {
        const texts = await promptTexts(w);
        return texts.filter((t) => t.includes("plumbing")).length === 2;
      });
      const resume = (await promptTexts(w)).filter((t) => t.includes("plumbing"))[1] ?? "";
      expect(resume).toContain("<untrusted>");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "/kick of an idle session sends no session/cancel but still resets the worktree",
    async () => {
      const w = await setup();
      await summon(w, "#haunt");
      const dir = wtPath(w, "haunt");
      const head = await dirty(dir, "haunt");

      w.op.send("KICK #haunt coder");
      await until(w, "exorcism to finish", () => exorcisedCount(w, "#haunt") === 1, true);

      expect(await requests(w, "session/cancel")).toHaveLength(0);
      await expectReset(dir, "haunt", head);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "the agent's own PART exorcises that channel and leaves other channels untouched",
    async () => {
      const w = await setup();
      await summon(w, "#haunt");
      await summon(w, "#crypt");
      await prompt(w, "#haunt", "dig the plumbing");
      const haunt = wtPath(w, "haunt");
      const crypt = wtPath(w, "crypt");
      const hauntHead = await dirty(haunt, "haunt");
      const cryptHead = await dirty(crypt, "crypt");

      agentClient(w, "coder").dispatch({ command: "PART", params: ["#haunt", "bye"] });
      await until(w, "exorcism to finish", () => exorcisedCount(w, "#haunt") === 1, true);

      expect(await requests(w, "session/cancel")).toHaveLength(1);
      await expectReset(haunt, "haunt", hauntHead);

      // Req 9.8: #crypt keeps its uncommitted work and its live session.
      expect(exorcisedCount(w, "#crypt")).toBe(0);
      expect(await git(crypt, ["rev-parse", "HEAD"])).toBe(cryptHead);
      expect(await readFile(join(crypt, "README.md"), "utf8")).toBe("scribbled by the agent\n");
      expect(await exists(join(crypt, "crypt-untracked.txt"))).toBe(true);
      expect(await namesOf(w, "#crypt")).toContain("coder");
      await prompt(w, "#crypt", "still alive?");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "QUIT of the agent exorcises every channel it is in",
    async () => {
      const w = await setup();
      await summon(w, "#haunt");
      await summon(w, "#crypt");
      await prompt(w, "#haunt", "dig the plumbing");
      const haunt = wtPath(w, "haunt");
      const crypt = wtPath(w, "crypt");
      const hauntHead = await dirty(haunt, "haunt");
      const cryptHead = await dirty(crypt, "crypt");

      agentClient(w, "coder").close("Quit: test");
      await until(
        w,
        "both exorcisms to finish",
        () => exorcisedCount(w, "#haunt") === 1 && exorcisedCount(w, "#crypt") === 1,
        true,
      );

      // Only the session with a turn in flight is cancelled (Req 9.5).
      expect(await requests(w, "session/cancel")).toHaveLength(1);
      await expectReset(haunt, "haunt", hauntHead);
      await expectReset(crypt, "crypt", cryptHead);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "Runner.ban makes the next /invite answer 401 and does not exorcise",
    async () => {
      const w = await setup();
      await w.op.join("#haunt");

      // Agent not online: the resolver declines, so the ircd itself answers 401 (Req 9.11).
      w.fx.runner.ban("#haunt", "coder");
      w.op.send("INVITE coder #haunt");
      await w.op.waitFor(/^:\S+ 401 \S+ coder /);
      expect(await w.op.expectNone(/^:\S+ 341 /)).toBe(true);
      expect(joinedCount(w, "#haunt")).toBe(0);
      expect(w.fx.server.ctx.connections.getByNick("coder")).toBeUndefined();

      // Lifting the ban lets the same invite through.
      expect(w.fx.runner.unban("#haunt", "coder")).toBe(true);
      w.op.send("INVITE coder #haunt");
      await w.op.waitFor(/^:\S+ 341 /);
      await until(w, "coder to join", () => joinedCount(w, "#haunt") === 1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "a ban does not exorcise; an online agent is refused with a NOTICE and stays out",
    async () => {
      const w = await setup();
      await summon(w, "#haunt");

      w.fx.runner.ban("#haunt", "coder");
      expect(exorcisedCount(w, "#haunt")).toBe(0);
      expect(await namesOf(w, "#haunt")).toContain("coder");

      w.op.send("KICK #haunt coder");
      await until(w, "exorcism to finish", () => exorcisedCount(w, "#haunt") === 1, true);

      // The virtual client is still online, so the ircd answers 341 and the runner refuses.
      w.op.send("INVITE coder #haunt");
      await w.op.waitFor(/NOTICE op :coder is banned from #haunt/);
      expect(joinedCount(w, "#haunt")).toBe(1);
      expect(await namesOf(w, "#haunt")).not.toContain("coder");
    },
    TEST_TIMEOUT_MS,
  );
});
