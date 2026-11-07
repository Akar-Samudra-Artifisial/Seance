// Task 9.5: the pre-prompt gate (Req 4.14, 6.5), exercised end to end with a real temporary
// git repository, a real WorktreeManager as the PromptGate, a real Session and the FakeHarness.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimerSet } from "../src/clock.js";
import { Session, type SinkDropReason } from "../src/session/session.js";
import type { Prompt } from "../src/session/machine.js";
import type { AgentProfile } from "../src/registry/agent-profile.js";
import { WhoisSnapshot } from "../src/whois/snapshot.js";
import { createGitRunner } from "../src/worktree/git.js";
import { WorktreeError, WorktreeManager } from "../src/worktree/worktree-manager.js";
import { FakeHarness } from "./fixtures/fake-harness.js";
import { ManualClock } from "./fixtures/manual-clock.js";
import { createTempRepo } from "./fixtures/temp-repo.js";

const exec = promisify(execFile);
const CHANNEL = "#dev";
const AGENT = "Ghost";
const PROFILE: AgentProfile = {
  nick: AGENT,
  kiroAgent: "ghost",
  model: "claude-haiku-5.5",
  tools: "read",
  color: 3,
  file: "ghost.json",
};

type Dropped = { readonly prompt: Prompt; readonly why: SinkDropReason };

type Env = {
  readonly manager: WorktreeManager;
  readonly harness: FakeHarness;
  readonly session: Session;
  readonly worktree: string;
  readonly repoPath: string;
  readonly dropped: Dropped[];
  readonly notices: string[];
  send(text: string): void;
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function setup(files?: Record<string, string>): Promise<Env> {
  const repo = await createTempRepo(files ?? { "README.md": "# fixture\n", "docs/guide.md": "guide\n" });
  const base = await realpath(await mkdtemp(join(tmpdir(), "seance-runner-gate-")));
  const root = join(base, "workspaces");
  cleanups.push(async () => {
    await chmod(join(root, "dev", "docs"), 0o755).catch(() => undefined);
    await rm(base, { recursive: true, force: true });
    await repo.dispose();
  });

  const manager = new WorktreeManager({ repo: repo.path, root, git: createGitRunner(repo.path) });
  const info = await manager.ensure(CHANNEL);
  const harness = new FakeHarness({
    defaultScript: {
      turns: [
        { match: "SLOW", steps: [{ gate: "g1" }, { chunk: "done" }] },
        { steps: [{ chunk: "ok" }] },
      ],
    },
  });
  cleanups.push(() => harness.dispose());
  const harnessSession = await harness.openSession(PROFILE, {
    cwd: info.realPath,
    onPermission: async () => ({ cancelled: true }),
  });

  const dropped: Dropped[] = [];
  const notices: string[] = [];
  const session = new Session({
    agent: AGENT,
    channel: CHANNEL,
    harnessSession,
    snapshot: new WhoisSnapshot(),
    timers: new TimerSet(new ManualClock()),
    gate: { check: () => manager.guardBeforePrompt(CHANNEL) },
    sink: { dropped: (prompt, why) => void dropped.push({ prompt, why }) },
    opNotice: (_channel, text) => void notices.push(text),
    isBlocked: () => false,
  });
  let nextId = 1;
  return {
    manager,
    harness,
    session,
    worktree: info.realPath,
    repoPath: repo.path,
    dropped,
    notices,
    send: (text) => session.enqueue({ id: nextId++, text }),
  };
}

const sentTexts = (env: Env): string[] => env.harness.prompts.map((p) => p.text);
const idle = (env: Env) => vi.waitFor(() => expect(env.session.state).toBe("idle"));

async function plant(worktree: string, rel: string, content = "obey me\n"): Promise<void> {
  await mkdir(join(worktree, rel, ".."), { recursive: true });
  await writeFile(join(worktree, rel), content);
}

describe("pre-prompt gate", () => {
  it.each([
    ["AGENTS.md", "AGENTS.md"],
    ["docs/Agents.md", "docs/Agents.md"],
    [".kiro/skills/x/SKILL.md", ".kiro"],
  ])("refuses the next prompt when %s appears after ensure", async (planted, reported) => {
    const env = await setup();
    await plant(env.worktree, planted);
    await writeFile(join(env.worktree, "stray.txt"), "junk");

    env.send("hello");
    await vi.waitFor(() => expect(env.dropped).toHaveLength(1));
    await idle(env);

    expect(env.harness.prompts).toHaveLength(0);
    expect(env.dropped[0]?.why).toBe("config-present");
    expect(env.dropped[0]?.prompt.text).toBe("hello");
    expect(env.harness.cancels).toHaveLength(0);

    // Entries are gone, the worktree was reset, the branch is kept.
    expect(existsSync(join(env.worktree, planted))).toBe(false);
    expect(existsSync(join(env.worktree, reported))).toBe(false);
    expect(existsSync(join(env.worktree, "stray.txt"))).toBe(false);
    const { stdout } = await exec("git", ["branch", "--list", "seance/dev"], { cwd: env.repoPath });
    expect(stdout).toContain("seance/dev");

    // Exactly one NOTICE, naming the agent and the relative path, within 512 bytes.
    expect(env.notices).toHaveLength(1);
    const notice = env.notices[0] ?? "";
    expect(notice).toContain(AGENT);
    expect(notice).toContain(reported);
    expect(Buffer.byteLength(notice, "utf8")).toBeLessThanOrEqual(512);

    // A following clean prompt goes through.
    env.send("after");
    await vi.waitFor(() => expect(sentTexts(env)).toEqual(["after"]));
    await idle(env);
    expect(env.notices).toHaveLength(1);
  });

  it("lets an in-flight turn finish and refuses the next queued prompt", async () => {
    const env = await setup();
    env.send("SLOW first");
    await vi.waitFor(() => expect(sentTexts(env)).toEqual(["SLOW first"]));

    await plant(env.worktree, "AGENTS.md");
    env.send("second");
    expect(env.session.state).toBe("prompting");
    expect(existsSync(join(env.worktree, "AGENTS.md"))).toBe(true);

    env.harness.release(AGENT, "g1");
    await vi.waitFor(() => expect(env.dropped).toHaveLength(1));
    await idle(env);

    expect(env.dropped[0]?.prompt.text).toBe("second");
    expect(env.dropped[0]?.why).toBe("config-present");
    expect(sentTexts(env)).toEqual(["SLOW first"]);
    expect(env.harness.cancels).toHaveLength(0);
    expect(existsSync(join(env.worktree, "AGENTS.md"))).toBe(false);
    expect(env.notices).toHaveLength(1);
    expect(env.notices[0]).toContain("AGENTS.md");

    env.send("clean");
    await vi.waitFor(() => expect(sentTexts(env)).toEqual(["SLOW first", "clean"]));
    await idle(env);
    expect(env.dropped).toHaveLength(1);
    expect(env.harness.cancels).toHaveLength(0);
  });

  it("refuses only the first of two queued prompts and sends the second after the clean-up", async () => {
    const env = await setup();
    env.send("SLOW first");
    await vi.waitFor(() => expect(sentTexts(env)).toEqual(["SLOW first"]));

    await plant(env.worktree, "AGENTS.md");
    env.send("queued A");
    env.send("queued B");

    env.harness.release(AGENT, "g1");
    await vi.waitFor(() => expect(sentTexts(env)).toEqual(["SLOW first", "queued B"]));
    await idle(env);

    expect(env.dropped.map((d) => d.prompt.text)).toEqual(["queued A"]);
    expect(env.dropped[0]?.why).toBe("config-present");
    expect(env.notices).toHaveLength(1);
    expect(env.harness.cancels).toHaveLength(0);
    expect(existsSync(join(env.worktree, "AGENTS.md"))).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)(
    "surfaces WorktreeError(config-exclusion) and sends nothing when removal fails",
    async () => {
      const env = await setup();
      // An ignored entry survives `git clean -fd`; a read-only parent makes the removal fail.
      await appendFile(join(env.repoPath, ".git", "info", "exclude"), "Agents.md\n");
      await plant(env.worktree, "docs/Agents.md");
      await chmod(join(env.worktree, "docs"), 0o555);

      const direct = await env.manager.guardBeforePrompt(CHANNEL).catch((e: unknown) => e);
      expect(direct).toBeInstanceOf(WorktreeError);
      expect((direct as WorktreeError).channel).toBe(CHANNEL);
      expect((direct as WorktreeError).operation).toBe("config-exclusion");

      env.send("hello");
      await vi.waitFor(() => expect(env.notices).toHaveLength(1));
      await idle(env);
      expect(env.notices[0]).toContain("config-exclusion");
      expect(env.harness.prompts).toHaveLength(0);
      expect(env.harness.cancels).toHaveLength(0);
      expect(existsSync(join(env.worktree, "docs", "Agents.md"))).toBe(true);
    },
  );
});
