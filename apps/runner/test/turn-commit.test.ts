// agent-sandbox Requirement 14 (task 6.5): host-side commits after an agent turn, against a real
// temporary repository with the hardened WorktreeManager. No Podman needed.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TimerSet } from "../src/clock.js";
import type { HarnessSession, SessionEvent, TurnResult } from "../src/harness/harness.js";
import type { RunnerLogger } from "../src/log.js";
import type { HostMembership } from "../src/ports.js";
import { turnCommitted } from "../src/services/notices.js";
import { Session } from "../src/session/session.js";
import { WhoisSnapshot } from "../src/whois/snapshot.js";
import { createGitRunner } from "../src/worktree/git.js";
import { createTurnCommitter } from "../src/worktree/turn-committer.js";
import { authorKey, WorktreeManager } from "../src/worktree/worktree-manager.js";
import { createTempRepo, type TempRepo } from "./fixtures/temp-repo.js";
import { ManualClock } from "./fixtures/manual-clock.js";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", args, { cwd })).stdout.trim();
const quiet: RunnerLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** A harness session whose turns end with the queued stop reasons; records prompts and cancels. */
class ScriptedSession implements HarnessSession {
  readonly id = "acp-1";
  readonly prompts: string[] = [];
  cancels = 0;
  readonly #stops: string[];
  constructor(stops: readonly string[]) {
    this.#stops = [...stops];
  }
  prompt(text: string): Promise<TurnResult> {
    this.prompts.push(text);
    return Promise.resolve({ stopReason: this.#stops.shift() ?? "end_turn" });
  }
  cancel(): void {
    this.cancels += 1;
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  onEvent(_l: (e: SessionEvent) => void): () => void {
    return () => undefined;
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise<void>((r) => setImmediate(r));
}

let repo: TempRepo;
let base: string;
let manager: WorktreeManager;
let worktree: string;
let mode: HostMembership | undefined;
let chanServ: string[];
let opNotices: string[];

beforeEach(async () => {
  repo = await createTempRepo({ "README.md": "# r\n", "src/a.ts": "export const a = 1;\n" });
  base = await realpath(await mkdtemp(join(tmpdir(), "seance-turn-commit-")));
  manager = new WorktreeManager({ repo: repo.path, root: join(base, "ws"), git: createGitRunner(repo.path, { hardened: true }), hardened: true });
  worktree = (await manager.ensure("#dev")).realPath;
  mode = { op: true, voice: false };
  chanServ = [];
  opNotices = [];
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
  await repo.dispose();
});

const committer = () =>
  createTurnCommitter({
    host: { modeOf: () => mode },
    worktrees: manager,
    logger: quiet,
    chanServ: (_c, text) => void chanServ.push(text),
    opNotice: (_c, text) => void opNotices.push(text),
  });

function session(harnessSession: HarnessSession, afterTurn: () => Promise<void> = () => committer()("coder", "#dev")): Session {
  return new Session({
    agent: "coder",
    channel: "#dev",
    harnessSession,
    snapshot: new WhoisSnapshot(),
    timers: new TimerSet(new ManualClock()),
    gate: { check: () => manager.guardBeforePrompt("#dev") },
    sink: { dropped: () => undefined },
    opNotice: (_c, text) => void opNotices.push(text),
    isBlocked: () => false,
    logger: quiet,
    afterTurn,
  });
}

const headCount = async (): Promise<number> => Number(await git(worktree, "rev-list", "--count", "HEAD"));

describe("WorktreeManager.commitTurn (14.2 to 14.4)", () => {
  it("commits every change, authored by the agent, committed by the runner", async () => {
    await writeFile(join(worktree, "src", "a.ts"), "export const a = 2;\n");
    await writeFile(join(worktree, "new.txt"), "new\n");
    const result = await manager.commitTurn("#dev", "Coder");
    expect(result).toEqual({ kind: "committed", sha: expect.stringMatching(/^[0-9a-f]{7}$/), files: 2 });
    expect(await git(worktree, "log", "-1", "--format=%an <%ae>|%cn <%ce>|%s")).toBe(
      "Coder <coder@seance.invalid>|Séance runner <runner@seance.invalid>|Coder: turn in #dev",
    );
    expect(await git(worktree, "status", "--porcelain")).toBe("");
    // The commit lands on the channel branch in the main repository.
    expect(await git(repo.path, "log", "-1", "--format=%an", "seance/dev")).toBe("Coder");
  });

  it("a clean worktree gives no commit", async () => {
    const before = await headCount();
    expect(await manager.commitTurn("#dev", "coder")).toEqual({ kind: "clean" });
    expect(await headCount()).toBe(before);
  });

  it("protected config present: refused, nothing committed", async () => {
    await mkdir(join(worktree, ".kiro"), { recursive: true });
    await writeFile(join(worktree, ".kiro", "x.md"), "x");
    await writeFile(join(worktree, "ok.txt"), "x");
    const before = await headCount();
    const result = await manager.commitTurn("#dev", "coder");
    expect(result.kind).toBe("refused");
    expect(await headCount()).toBe(before);
  });

  it("runs no repository hook and ignores core.hooksPath (14.2)", async () => {
    const marker = join(base, "hook-ran");
    const hooks = join(base, "hooks");
    await mkdir(hooks);
    for (const name of ["pre-commit", "commit-msg", "post-commit"]) {
      const script = join(hooks, name);
      await writeFile(script, `#!/bin/sh\ntouch '${marker}'\n`);
      await chmod(script, 0o755);
      await writeFile(join(repo.path, ".git", "hooks", name), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    }
    await git(repo.path, "config", "core.hooksPath", hooks);
    await writeFile(join(worktree, "x.txt"), "x");
    expect((await manager.commitTurn("#dev", "coder")).kind).toBe("committed");
    expect(existsSync(marker)).toBe(false);
  });

  it("authorKey keeps [a-z0-9._-] only", () => {
    expect(authorKey("Al[X]")).toBe("al-x-");
    expect(authorKey("co.der_1")).toBe("co.der_1");
  });
});

describe("the turn hook (14.1, 14.5 to 14.7)", () => {
  it("commits after an end_turn of a +o agent and posts the ChanServ line", async () => {
    const h = new ScriptedSession(["end_turn"]);
    const s = session(h);
    await writeFile(join(worktree, "work.txt"), "done\n");
    s.enqueue({ id: 1, text: "do it" });
    await vi.waitFor(() => expect(chanServ).toHaveLength(1), { timeout: 10_000 });
    await vi.waitFor(() => expect(s.state).toBe("idle"));
    const sha = (await git(worktree, "rev-parse", "--short=7", "HEAD")).trim();
    expect(chanServ).toEqual([turnCommitted({ agent: "coder", sha, files: 1 })]);
    expect(chanServ[0]).toBe(`coder committed ${sha} (1 file)`);
  });

  it("no +o, no commit", async () => {
    mode = { op: false, voice: true };
    const s = session(new ScriptedSession(["end_turn"]));
    await writeFile(join(worktree, "work.txt"), "done\n");
    const before = await headCount();
    s.enqueue({ id: 1, text: "do it" });
    await vi.waitFor(() => expect(s.state).toBe("idle"), { timeout: 10_000 });
    await flush();
    expect(await headCount()).toBe(before);
    expect(chanServ).toEqual([]);
  });

  it.each(["cancelled", "max_tokens"])("no commit after a turn that ended %s", async (stop) => {
    let called = 0;
    const s = session(new ScriptedSession([stop]), () => {
      called += 1;
      return Promise.resolve();
    });
    s.enqueue({ id: 1, text: "x" });
    await vi.waitFor(() => expect(s.state).not.toBe("prompting"), { timeout: 10_000 });
    expect(called).toBe(0);
  });

  it("no commit while the Session is closing (a kick discards the turn)", async () => {
    let release: (() => void) | undefined;
    const gated: HarnessSession = {
      id: "acp-2",
      prompt: () =>
        new Promise<TurnResult>((resolve) => {
          release = () => resolve({ stopReason: "end_turn" });
        }),
      cancel: () => undefined,
      close: () => Promise.resolve(),
      onEvent: () => () => undefined,
    };
    let called = 0;
    const s = session(gated, () => {
      called += 1;
      return Promise.resolve();
    });
    s.enqueue({ id: 1, text: "x" });
    await vi.waitFor(() => expect(release).toBeDefined(), { timeout: 10_000 });
    s.beginClosing();
    release?.();
    await vi.waitFor(() => expect(s.state).toBe("idle"));
    expect(called).toBe(0);
  });

  it("the next prompt waits for the commit, and a cancel during it sends no session/cancel", async () => {
    const h = new ScriptedSession(["end_turn", "end_turn"]);
    let finish: () => void = () => undefined;
    let hookStarted = false;
    const s = session(h, () => {
      hookStarted = true;
      return new Promise<void>((r) => (finish = r));
    });
    s.enqueue({ id: 1, text: "first" });
    s.enqueue({ id: 2, text: "second" });
    await vi.waitFor(() => expect(hookStarted).toBe(true), { timeout: 10_000 });
    expect(h.prompts).toEqual(["first"]);
    s.cancel();
    await flush();
    expect(h.cancels).toBe(0);
    finish();
    await flush();
    expect(h.cancels).toBe(0);
  });

  it("the next prompt is sent once the commit is done", async () => {
    const h = new ScriptedSession(["end_turn", "end_turn"]);
    let finish: () => void = () => undefined;
    let hooks = 0;
    const s = session(h, () => {
      hooks += 1;
      return new Promise<void>((r) => (finish = r));
    });
    s.enqueue({ id: 1, text: "first" });
    s.enqueue({ id: 2, text: "second" });
    await vi.waitFor(() => expect(hooks).toBe(1), { timeout: 10_000 });
    await flush();
    expect(h.prompts).toEqual(["first"]);
    finish();
    await vi.waitFor(() => expect(h.prompts).toEqual(["first", "second"]), { timeout: 10_000 });
  });

  it("a failing commit is reported to the ops once and the turn still ends", async () => {
    const broken = createTurnCommitter({
      host: { modeOf: () => ({ op: true, voice: false }) },
      worktrees: { commitTurn: () => Promise.reject(new Error("disk full")) },
      logger: quiet,
      opNotice: (_c, text) => void opNotices.push(text),
    });
    const s = session(new ScriptedSession(["end_turn"]), () => broken("coder", "#dev"));
    s.enqueue({ id: 1, text: "x" });
    await vi.waitFor(() => expect(opNotices).toEqual(["coder: commit failed in #dev (see the runner log)"]), { timeout: 10_000 });
    await vi.waitFor(() => expect(s.state).toBe("idle"));
  });
});

// Review finding 1 (HIGH): a nested repository is agent-controlled git config. The host must never
// stage, commit or descend into it, and no host git call may run an fsmonitor or recurse.
describe("nested git is refused (review finding 1)", () => {
  const IDENT = ["-c", "user.name=Agent", "-c", "user.email=agent@example.invalid", "-c", "commit.gpgsign=false"];

  it("PoC: turn 1 `git init sub` + commit, turn 2 sets core.fsmonitor in sub/.git/config; the marker never runs, both turns are refused", async () => {
    const marker = join(base, "fsmonitor-ran");
    const script = join(base, "fsmonitor.sh");
    await writeFile(script, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    const refused: unknown[] = [];
    const logger: RunnerLogger = { ...quiet, warn: (msg, fields) => void (msg === "host commit refused: protected config in the worktree" && refused.push(fields)) };
    const commit = createTurnCommitter({
      host: { modeOf: () => ({ op: true, voice: false }) },
      worktrees: manager,
      logger,
      chanServ: (_c, text) => void chanServ.push(text),
      opNotice: (_c, text) => void opNotices.push(text),
    });
    const before = await headCount();

    // Turn 1: the agent initialises a nested repository and commits it.
    const sub = join(worktree, "sub");
    await mkdir(sub, { recursive: true });
    await exec("git", ["init", "-q", sub]);
    await writeFile(join(sub, "a.txt"), "x\n");
    await exec("git", ["-C", sub, "add", "a.txt"]);
    await exec("git", ["-C", sub, ...IDENT, "commit", "-q", "-m", "nested"]);
    await commit("coder", "#dev");
    expect(await headCount()).toBe(before); // nested .git refused the commit

    // Turn 2: the agent points the nested repo's fsmonitor at a marker script.
    await exec("git", ["-C", sub, "config", "core.fsmonitor", script]);
    await writeFile(join(sub, "b.txt"), "y\n");
    await commit("coder", "#dev");

    expect(existsSync(marker)).toBe(false); // no host git call ran the fsmonitor
    expect(await headCount()).toBe(before);
    expect(refused.length).toBeGreaterThanOrEqual(2);
  });

  it("commitTurn refuses a nested .git and a .gitmodules like AGENTS.md/.kiro", async () => {
    await mkdir(join(worktree, "sub"), { recursive: true });
    await exec("git", ["init", "-q", join(worktree, "sub")]);
    expect((await manager.commitTurn("#dev", "coder")).kind).toBe("refused");

    await rm(join(worktree, "sub"), { recursive: true, force: true });
    await writeFile(join(worktree, ".gitmodules"), "[submodule]\n");
    expect((await manager.commitTurn("#dev", "coder")).kind).toBe("refused");
  });
});
