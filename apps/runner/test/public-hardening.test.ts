// public-hardening (runner side): inviter accounts, !reset-credits, the credits file, the daily
// budget, WHOIS budget line, redaction of the Kiro login, auth path refusal, git timeout and the
// worktree size cap.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REDACTED } from "../src/acp/redact.js";
import { TimerSet } from "../src/clock.js";
import { loadRunnerConfig } from "../src/config.js";
import type { HarnessSession, SessionEvent, TurnResult } from "../src/harness/harness.js";
import { buildChannelSession } from "../src/invite/channel-session.js";
import type { RunnerLogger } from "../src/log.js";
import { AgentOutput } from "../src/output/agent-output.js";
import type { HostVirtualClient } from "../src/ports.js";
import type { AgentProfile } from "../src/registry/agent-profile.js";
import { assertPublicRunner, isLoopbackIpLiteral } from "../src/runner.js";
import { DailyBudget, utcDay } from "../src/credits/budget.js";
import { CREDITS_FILE_NAME, CreditsFile, CreditsFileError } from "../src/credits/credits-file.js";
import { CreditAccumulator } from "../src/credits/accumulator.js";
import { CreditLedger } from "../src/credits/ledger.js";
import type { CancellableSession } from "../src/credits/ledger.js";
import { createResetCreditsHandler } from "../src/credits/reset-command.js";
import { parseInviters } from "../src/invite/allow-list.js";
import { isAuthPath, matchDenyList, referencesAuthPath } from "../src/permissions/deny-list.js";
import { decide } from "../src/permissions/policy.js";
import { readAuthSecrets, secretsInFile } from "../src/sandbox/auth-secrets.js";
import { SecretRedactor, variantsOf } from "../src/output/secret-redactor.js";
import type { SessionRecord } from "../src/session/session-store.js";
import { MemorySessionStore } from "../src/session/memory-session-store.js";
import { renderWhois } from "../src/whois/render.js";
import { WhoisSnapshot } from "../src/whois/snapshot.js";
import { createGitRunner, GitError, runGit } from "../src/worktree/git.js";
import type { GitRunner } from "../src/worktree/git.js";
import { exceedsBytes, WorktreeManager } from "../src/worktree/worktree-manager.js";
import { createTurnCommitter } from "../src/worktree/turn-committer.js";
import { createTempRepo, type TempRepo } from "./fixtures/temp-repo.js";
import { ManualClock } from "./fixtures/manual-clock.js";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", args, { cwd })).stdout.trim();

let dir: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "seance-hardening-")));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("inviters need an account (Requirement 3)", () => {
  it("with accounts, an allowed nick must be logged in as its own account", () => {
    const logins = new Map<string, string>([["alice", "Alice"], ["mallory", "Bob"]]);
    const list = parseInviters(["alice", "bob"], { required: true, accountOf: (n) => logins.get(n.toLowerCase()) });
    expect(list.allows("ALICE")).toBe(true);
    expect(list.allows("bob")).toBe(false); // not logged in
    expect(list.allows("mallory")).toBe(false); // logged in as someone else, not listed
    // An empty list permits every authenticated account, never a guest.
    const open = parseInviters([], { required: true, accountOf: (n) => logins.get(n) });
    expect(open.allows("alice")).toBe(true);
    expect(open.allows("guest")).toBe(false);
  });

  it("without accounts the old nick-only check stays", () => {
    const list = parseInviters(["alice"], { required: false, accountOf: () => undefined });
    expect(list.allows("alice")).toBe(true);
    expect(parseInviters(["alice"]).allows("bob")).toBe(false);
  });

  it("!reset-credits needs an Inviter with +o", () => {
    const ledger = { blockedChannelsOf: () => ["#dev"], clearBlocked: vi.fn(() => true) } as unknown as CreditLedger;
    const notices: string[] = [];
    const handle = createResetCreditsHandler({
      ledger,
      modeOf: () => ({ op: true, voice: false }),
      noticeTo: (_n, t) => {
        notices.push(t);
        return true;
      },
      isInviter: (n) => n === "alice",
    });
    expect(handle("eve", "coder").kind).toBe("not-operator");
    expect(notices.at(-1)).toBe("only an authenticated inviter with operator rights (+o) may reset credits of coder");
    expect(handle("alice", "coder")).toEqual({ kind: "cleared", cleared: ["#dev"], kept: [] });
  });
});

describe("credits file (Requirement 5.1)", () => {
  const record: SessionRecord = { agent: "coder", channel: "#dev", acpSessionId: "s1", status: "idle", creditsUsed: 1.5, updatedAt: 7 };

  it("round-trips records and the daily state, written atomically with mode 0600", async () => {
    const a = new CreditsFile(dir);
    await a.put(record);
    await a.putDaily({ day: "2026-11-08", credits: 3 });
    await a.flush();
    const path = join(dir, CREDITS_FILE_NAME);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const b = new CreditsFile(dir);
    expect(await b.list()).toEqual([record]);
    expect(b.daily()).toEqual({ day: "2026-11-08", credits: 3 });
    // No temporary file is left behind.
    expect((await readdir(dir)).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  it("a corrupt file stops the start; a missing one is empty; bad records are skipped and reported", async () => {
    expect(await new CreditsFile(dir).list()).toEqual([]);
    await writeFile(join(dir, CREDITS_FILE_NAME), "{nope");
    expect(() => new CreditsFile(dir)).toThrow(CreditsFileError);
    await writeFile(
      join(dir, CREDITS_FILE_NAME),
      JSON.stringify({ version: 1, sessions: [record, { agent: 1 }], daily: { day: 5, credits: "x" } }),
    );
    const skipped: string[] = [];
    expect(await new CreditsFile(dir, (what, reason) => skipped.push(`${what}: ${reason}`)).list()).toEqual([record]);
    // Requirement 16.3: never silently.
    expect(skipped).toEqual(["session record 1: invalid fields", "daily state: invalid fields"]);
  });

  it("a restart keeps the totals: the ledger restores from the file", async () => {
    const clock = new ManualClock();
    const store = new CreditsFile(dir);
    const ledger1 = new CreditLedger({ store, snapshot: new WhoisSnapshot(), clock, sessionsOf: () => [], opNotice: () => undefined });
    ledger1.add("coder", "#dev", 2.25);
    await ledger1.flush();
    await store.flush();
    const ledger2 = new CreditLedger({ store: new CreditsFile(dir), snapshot: new WhoisSnapshot(), clock, sessionsOf: () => [], opNotice: () => undefined });
    await ledger2.restore();
    expect(ledger2.amount("coder", "#dev")).toBe(2.25);
  });
});

describe("daily budget (Requirement 5.2)", () => {
  const DAY = Date.UTC(2026, 10, 8, 12);

  it("counts per UTC day, reports the crossing once and rolls over at midnight", () => {
    let now = DAY;
    const b = new DailyBudget(() => now, 10);
    expect(b.add(6)).toBe(false);
    expect(b.reached()).toBe(false);
    expect(b.add(5)).toBe(true);
    expect(b.add(1)).toBe(false); // announced once
    expect(b.reached()).toBe(true);
    now = Date.UTC(2026, 10, 9, 0, 0, 1);
    expect(b.reached()).toBe(false);
    expect(b.today()).toBe(0);
    expect(b.state().day).toBe("2026-11-09");
  });

  it("restores today's total, ignores an older day", () => {
    expect(new DailyBudget(() => DAY, 10, { day: utcDay(DAY), credits: 4 }).today()).toBe(4);
    expect(new DailyBudget(() => DAY, 10, { day: "2026-11-07", credits: 4 }).today()).toBe(0);
    expect(() => new DailyBudget(() => DAY, 0)).toThrow(RangeError);
  });

  it("the ledger cancels prompting Sessions and notifies once when the cap is crossed", async () => {
    const clock = new ManualClock(DAY);
    const daily = new DailyBudget(() => clock.now(), 1);
    const cancel = vi.fn();
    const sessions: CancellableSession[] = [
      { agent: "coder", state: "prompting", cancel },
      { agent: "reviewer", state: "idle", cancel: vi.fn() },
    ];
    const onDailyCapReached = vi.fn();
    const persisted: unknown[] = [];
    const ledger = new CreditLedger({
      store: new MemorySessionStore(),
      snapshot: new WhoisSnapshot(),
      clock,
      sessionsOf: () => [],
      opNotice: () => undefined,
      daily,
      persistDaily: async (s) => {
        persisted.push(s);
      },
      allSessions: () => sessions,
      onDailyCapReached,
    });
    ledger.add("coder", "#a", 0.6);
    expect(ledger.dailyCapReached()).toBe(false);
    ledger.add("reviewer", "#b", 0.6);
    ledger.add("reviewer", "#b", 0.1);
    expect(ledger.dailyCapReached()).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(onDailyCapReached).toHaveBeenCalledTimes(1);
    // Requirement 16.2 (changed from one write per add): the daily state is written with the
    // coalesced flush, once for the three adds.
    expect(persisted).toHaveLength(0);
    await ledger.flush();
    expect(persisted).toHaveLength(1);
    expect((persisted[0] as { credits: number }).credits).toBeCloseTo(1.3);
  });

  it("private metering adds to the daily budget only (Requirement 12.1)", () => {
    const daily = new DailyBudget(() => DAY, 10);
    const snapshot = new WhoisSnapshot();
    const ledger = new CreditLedger({ store: new MemorySessionStore(), snapshot, clock: new ManualClock(DAY), sessionsOf: () => [], opNotice: () => undefined, daily });
    const acc = new CreditAccumulator("coder@private:alice:s1");
    ledger.recordPrivateMetering(acc, [{ value: 1.25, unit: "credit" }, { value: 3, unit: "token" }]);
    expect(daily.today()).toBe(1.25);
    expect(ledger.agentTotal("coder")).toBe(0);
    expect(snapshot.get("coder")).toBeUndefined();
  });

  it("WHOIS shows the budget line right after the status line (Requirement 5.4)", () => {
    const b = new DailyBudget(() => DAY, 20);
    b.add(1.5);
    expect(b.line(false)).toBe("budget: today 1.50 / 20.00 (UTC)");
    expect(b.line(true)).toBe("budget: today 1.50 / 20.00 (UTC), paused");
    b.add(19);
    expect(b.line(false)).toBe("budget: today 20.50 / 20.00 (UTC), reached");
    expect(new DailyBudget(() => DAY, undefined).line(false)).toBe("budget: today 0.00 (no daily cap)");
    const snapshot = new WhoisSnapshot();
    snapshot.register("coder", { model: "m", tools: "read" });
    const lines = renderWhois(snapshot.get("coder"), b.line(false));
    const status = lines.findIndex((l) => l.startsWith("status:"));
    expect(status).toBeGreaterThanOrEqual(0);
    expect(lines[status + 1]).toBe("budget: today 20.50 / 20.00 (UTC), reached");
    expect(renderWhois(snapshot.get("coder")).some((l) => l.startsWith("budget:"))).toBe(false);
  });
});

describe("Kiro login secrets (Requirement 6)", () => {
  it("reads token-shaped JSON values and token runs, not URLs or prose", () => {
    const json = Buffer.from(
      JSON.stringify({
        accessToken: "aoaAAAAAGcR4tZq1-example-access-token-value",
        nested: { refreshToken: "Atzr|IwEBIexampleRefresh" },
        startUrl: "https://example.awsapps.com/start",
        region: "us-east-1",
        expiresAt: "2026-11-08T12:00:00Z",
        clientName: "kiro cli client name",
      }),
    );
    expect(secretsInFile(json)).toEqual(["aoaAAAAAGcR4tZq1-example-access-token-value", "Atzr|IwEBIexampleRefresh"]);
    const binary = Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from("x eyJhbGciOiJIUzI1NiJ9.payload123 y"), Buffer.from([0])]);
    expect(secretsInFile(binary)).toEqual(["eyJhbGciOiJIUzI1NiJ9.payload123"]);
  });

  it("walks the auth dir without following symlinks", async () => {
    await mkdir(join(dir, "auth", "sub"), { recursive: true });
    await writeFile(join(dir, "auth", "sub", "token.json"), JSON.stringify({ t: "Token0123456789abcdefXYZ" }));
    await writeFile(join(dir, "outside.json"), JSON.stringify({ t: "Outside0123456789abcdefXYZ" }));
    await symlink(join(dir, "outside.json"), join(dir, "auth", "link.json"));
    expect(await readAuthSecrets(join(dir, "auth"))).toEqual(["Token0123456789abcdefXYZ"]);
    const skipped: string[] = [];
    expect(await readAuthSecrets(join(dir, "missing"), (p) => skipped.push(p))).toEqual([]);
    expect(skipped).toHaveLength(1);
  });

  it("redacts raw, base64, base64url and hex forms and 8-character fragments", () => {
    const secret = "Kiro-Token-0123456789-abcdef";
    const r = new SecretRedactor([secret]);
    for (const v of variantsOf(secret)) {
      expect(r.redact(`see ${v} here`)).not.toContain(v.slice(0, 8));
    }
    expect(r.redact(`partial ${secret.slice(5, 15)} end`)).toBe(`partial ${REDACTED} end`);
    expect(r.redact("nothing secret here")).toBe("nothing secret here");
  });

  it("redacts the continuation of a secret split over two lines of one channel", () => {
    const secret = "SPLITsecret0123456789";
    const r = new SecretRedactor([secret]);
    const first = r.redact(`token: ${secret.slice(0, 4)}`, "coder\0#dev");
    const second = r.redact(`${secret.slice(4)} done`, "coder\0#dev");
    expect(first).toBe(`token: ${secret.slice(0, 4)}`); // under 8 characters: the documented residual risk
    expect(second).not.toContain(secret.slice(4, 12));
    // Another channel is not joined to it.
    expect(new SecretRedactor([secret]).redact("0123", "x")).toBe("0123");
  });

  it("refuses shell commands and tool paths that touch the Kiro login, even for reads by +o", () => {
    expect(referencesAuthPath("cat /run/seance/auth/token.json")).toBe(true);
    expect(referencesAuthPath('cat ~/".local/share/kiro-cli"/data.sqlite3')).toBe(true);
    expect(matchDenyList("ls ~/.aws/sso/cache", "/wt")).toEqual({ reason: "protected-path" });
    expect(isAuthPath("/home/agent/.local/share/kiro-cli/data.sqlite3")).toBe(true);
    expect(isAuthPath("/wt/src/a.ts")).toBe(false);
    const read = decide({
      mode: "op",
      tool: { kind: "read", paths: [{ raw: "/run/seance/auth/token.json", resolved: "/run/seance/auth/token.json" }] },
      worktree: "/wt",
    });
    expect(read).toEqual({ decision: "reject_once", reason: "protected-path" });
  });
});

describe("host git (Requirement 9)", () => {
  it("a hung git is killed at its timeout and reported as timedOut", async () => {
    // `hash-object --stdin` waits for stdin forever: a stand-in for a lock or a hostile hook.
    const err = await runGit(["hash-object", "--stdin"], undefined, 200).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect((err as GitError).timedOut).toBe(true);
    expect((err as GitError).message).toMatch(/timed out after 200 ms/);
  });

  it("exceedsBytes stops at the limit and ignores .git", async () => {
    await mkdir(join(dir, ".git"));
    await writeFile(join(dir, ".git", "big"), Buffer.alloc(5000));
    await mkdir(join(dir, "a"));
    await writeFile(join(dir, "a", "f"), Buffer.alloc(600));
    expect(await exceedsBytes(dir, 1000)).toBe(false);
    await writeFile(join(dir, "g"), Buffer.alloc(600));
    expect(await exceedsBytes(dir, 1000)).toBe(true);
  });

  describe("commitTurn", () => {
    let repo: TempRepo;
    beforeEach(async () => {
      repo = await createTempRepo({ "README.md": "# r\n" });
    });
    afterEach(async () => {
      await repo.dispose();
    });

    const manager = (git: GitRunner, maxBytes?: number): WorktreeManager =>
      new WorktreeManager({ repo: repo.path, root: join(dir, "ws"), git, hardened: true, ...(maxBytes !== undefined ? { maxBytes } : {}) });

    it("an oversized worktree is reset, not committed, and the ops are told", async () => {
      const m = manager(createGitRunner(repo.path, { hardened: true }), 1000);
      const wt = (await m.ensure("#dev")).realPath;
      const head = await git(wt, "rev-parse", "HEAD");
      await writeFile(join(wt, "huge.bin"), Buffer.alloc(2000));
      expect(await m.commitTurn("#dev", "coder")).toEqual({ kind: "reset", reason: "the worktree is larger than 1000 bytes" });
      expect(await git(wt, "rev-parse", "HEAD")).toBe(head);
      expect(existsSync(join(wt, "huge.bin"))).toBe(false);

      const notices: string[] = [];
      await writeFile(join(wt, "huge.bin"), Buffer.alloc(2000));
      await createTurnCommitter({
        host: { modeOf: () => ({ op: true, voice: false }) },
        worktrees: m,
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        opNotice: (_c, t) => void notices.push(t),
      })("coder", "#dev");
      expect(notices).toEqual(["coder: turn not committed in #dev, worktree reset (the worktree is larger than 1000 bytes)"]);
    });

    it("the oversize reset also removes ignored files; exceedsCap reports the size (Requirement 14)", async () => {
      const m = manager(createGitRunner(repo.path, { hardened: true }), 1000);
      const wt = (await m.ensure("#dev")).realPath;
      await writeFile(join(wt, ".gitignore"), "cache/\n");
      await git(wt, "add", ".gitignore");
      await git(wt, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "ignore cache");
      expect(await m.exceedsCap("#dev")).toBe(false);
      await mkdir(join(wt, "cache"));
      await writeFile(join(wt, "cache", "blob.bin"), Buffer.alloc(2000));
      expect(await m.exceedsCap("#dev")).toBe(true);
      expect((await m.commitTurn("#dev", "coder")).kind).toBe("reset");
      expect(existsSync(join(wt, "cache", "blob.bin"))).toBe(false);
      expect(existsSync(join(wt, ".gitignore"))).toBe(true);
      // Without a cap nothing is ever over it.
      expect(await manager(createGitRunner(repo.path, { hardened: true })).exceedsCap("#dev")).toBe(false);
    });

    it("a git timeout during the commit resets the turn and releases the per-repository mutex", async () => {
      const real = createGitRunner(repo.path, { hardened: true });
      let hang = false;
      const flaky: GitRunner = {
        run: (args) =>
          hang && args.includes("commit")
            ? Promise.reject(new GitError(args, undefined, "", "timed out after 1 ms", true))
            : real.run(args),
        locked: (fn) => real.locked(fn),
      };
      const m = manager(flaky);
      const wt = (await m.ensure("#dev")).realPath;
      const head = await git(wt, "rev-parse", "HEAD");
      await writeFile(join(wt, "work.txt"), "x\n");
      hang = true;
      expect(await m.commitTurn("#dev", "coder")).toEqual({ kind: "reset", reason: "git timed out" });
      expect(await git(wt, "rev-parse", "HEAD")).toBe(head);
      expect(await git(wt, "status", "--porcelain")).toBe("");
      // The mutex is free: the next locked call runs at once.
      expect(await real.locked(async () => "free")).toBe("free");
      hang = false;
      await writeFile(join(wt, "work.txt"), "y\n");
      expect((await m.commitTurn("#dev", "coder")).kind).toBe("committed");
      expect(await readFile(join(wt, "work.txt"), "utf8")).toBe("y\n");
    });
  });
});

describe("worktree size during a turn (Requirement 14.1)", () => {
  /** A harness session whose prompt resolves only when cancelled; tests push events into it. */
  class HangingSession implements HarnessSession {
    readonly id = "acp-1";
    cancels = 0;
    #listeners = new Set<(e: SessionEvent) => void>();
    #resolve: ((r: TurnResult) => void) | undefined;
    prompt(): Promise<TurnResult> {
      return new Promise((resolve) => {
        this.#resolve = resolve;
      });
    }
    cancel(): void {
      this.cancels += 1;
      this.#resolve?.({ stopReason: "cancelled" });
    }
    close(): Promise<void> {
      return Promise.resolve();
    }
    onEvent(l: (e: SessionEvent) => void): () => void {
      this.#listeners.add(l);
      return () => this.#listeners.delete(l);
    }
    emit(e: SessionEvent): void {
      for (const l of this.#listeners) l(e);
    }
  }

  const flushAll = async (): Promise<void> => {
    for (let i = 0; i < 40; i++) await new Promise<void>((r) => setImmediate(r));
  };

  function build(over: boolean | (() => Promise<boolean>), mode: { op: boolean; voice: boolean } = { op: true, voice: false }) {
    const exceedsCap = typeof over === "function" ? over : async () => over;
    const h = new HangingSession();
    const reset = vi.fn(async () => ({ target: "abc1234", filesReverted: 1 }));
    const notices: string[] = [];
    const quiet: RunnerLogger = { debug() {}, info() {}, warn() {}, error() {} };
    const client = { id: "c", nick: "coder", virtual: true, send() {}, dispatch: () => undefined, onMessage: () => () => undefined, setAway() {}, close() {} } as unknown as HostVirtualClient;
    const clock = new ManualClock();
    const session = buildChannelSession(
      {
        host: { modeOf: () => mode },
        worktrees: { guardBeforePrompt: async () => ({ ok: true }), exceedsCap, reset },
        snapshot: new WhoisSnapshot(),
        ledger: { recordMetering: () => ({ accepted: 0, rejected: [] }) } as unknown as Pick<CreditLedger, "recordMetering">,
        clock,
        timers: new TimerSet(clock),
        logger: quiet,
        opNotice: (_c, t) => void notices.push(t),
      },
      { nick: "coder", kiroAgent: "coder", model: "m", tools: "read", color: 12 } as unknown as AgentProfile,
      "#dev",
      h,
      new AgentOutput({ client, logger: quiet, nick: "coder", user: "coder", host: "seance", color: 12 }),
    );
    return { h, session, reset, notices };
  }

  it("over the cap after a finished tool call: the turn is cancelled and the worktree reset with ignored files", async () => {
    const { h, session, reset, notices } = build(true);
    session.enqueue({ id: 1, text: "fill the disk" });
    await flushAll();
    expect(session.state).toBe("prompting");
    h.emit({ kind: "tool-done", status: "completed" });
    await flushAll();
    expect(h.cancels).toBe(1);
    expect(notices).toEqual(["coder: turn cancelled in #dev, the worktree is over its size cap; it will be reset"]);
    expect(reset).toHaveBeenCalledWith("#dev", { ignored: true });
  });

  it("under the cap nothing happens", async () => {
    const { h, session, reset } = build(false);
    session.enqueue({ id: 1, text: "work" });
    await flushAll();
    h.emit({ kind: "tool-done", status: "completed" });
    await flushAll();
    expect(h.cancels).toBe(0);
    expect(reset).not.toHaveBeenCalled();
    h.cancel();
  });

  /** exceedsCap results the test resolves by hand, in order. */
  function manualChecks() {
    const waiting: ((over: boolean) => void)[] = [];
    const fn = vi.fn(() => new Promise<boolean>((resolve) => waiting.push(resolve)));
    const next = (over: boolean): void => {
      const r = waiting.shift();
      if (r === undefined) throw new Error("no size check is waiting");
      r(over);
    };
    return { fn, next, waiting };
  }

  it("a tool-done during a running check makes the check run again afterwards (re-check 2)", async () => {
    const checks = manualChecks();
    const { h, session } = build(checks.fn);
    session.enqueue({ id: 1, text: "work" });
    await flushAll();
    h.emit({ kind: "tool-done", status: "completed" });
    h.emit({ kind: "tool-done", status: "completed" }); // arrives while the first check runs
    h.emit({ kind: "tool-done", status: "failed" });
    await flushAll();
    expect(checks.fn).toHaveBeenCalledTimes(1);
    checks.next(false);
    await flushAll();
    // Exactly one follow-up check covers both tool calls that arrived meanwhile.
    expect(checks.fn).toHaveBeenCalledTimes(2);
    checks.next(true);
    await flushAll();
    expect(h.cancels).toBe(1);
  });

  it("a result that resolves after the turn ended still applies (re-check 2)", async () => {
    const checks = manualChecks();
    const { h, session, reset, notices } = build(checks.fn);
    session.enqueue({ id: 1, text: "work" });
    await flushAll();
    h.emit({ kind: "tool-done", status: "completed" });
    await flushAll();
    h.cancel(); // the turn ends (here by a cancel from elsewhere) while the check still runs
    await flushAll();
    expect(session.state).not.toBe("prompting");
    checks.next(true); // the late result: over the cap
    await flushAll();
    expect(reset).toHaveBeenCalledWith("#dev", { ignored: true });
    expect(notices).toContain("coder: the worktree in #dev is over its size cap; it was reset");
    // The final check from the turn end runs after it (pending) and resets again if still over.
    checks.next(false);
    await flushAll();
  });

  it("a final check runs at every turn end, also for an agent without +o that never commits (re-check 2)", async () => {
    const checks = manualChecks();
    const { h, session, reset } = build(checks.fn, { op: false, voice: true });
    session.enqueue({ id: 1, text: "talk" });
    await flushAll();
    expect(checks.fn).not.toHaveBeenCalled(); // no tool call happened
    h.cancel(); // the turn ends
    await flushAll();
    expect(checks.fn).toHaveBeenCalledTimes(1);
    checks.next(true);
    await flushAll();
    expect(reset).toHaveBeenCalledWith("#dev", { ignored: true });
  });

  it("a failing size check counts as over the cap (fail closed, re-check 1)", async () => {
    const { h, session } = build(() => Promise.reject(new Error("EACCES: permission denied")));
    session.enqueue({ id: 1, text: "work" });
    await flushAll();
    h.emit({ kind: "tool-done", status: "completed" });
    await flushAll();
    expect(h.cancels).toBe(1);
  });
});

describe("exceedsBytes walk errors (re-check 1)", () => {
  type Entry = { readonly name: string; isDirectory(): boolean; isFile(): boolean };
  const file = (name: string): Entry => ({ name, isDirectory: () => false, isFile: () => true });
  const folder = (name: string): Entry => ({ name, isDirectory: () => true, isFile: () => false });
  const errno = (code: string): Error => Object.assign(new Error(code), { code });

  it("skips entries that vanish during the walk (ENOENT)", async () => {
    const io = {
      readdir: async (p: string) => (p === "/wt" ? [file("gone.txt"), folder("gone-dir"), file("a")] : Promise.reject(errno("ENOENT"))),
      lstat: async (p: string) => (p === "/wt/gone.txt" ? Promise.reject(errno("ENOENT")) : { size: 10 }),
    };
    expect(await exceedsBytes("/wt", 100, io)).toBe(false);
    expect(await exceedsBytes("/wt", 5, io)).toBe(true);
  });

  it.each(["EACCES", "EIO", "ELOOP"])("any other error (%s) counts as over the cap", async (code) => {
    const failingReaddir = {
      readdir: async (p: string) => (p === "/wt" ? [folder("locked")] : Promise.reject(errno(code))),
      lstat: async () => ({ size: 1 }),
    };
    expect(await exceedsBytes("/wt", 1_000_000, failingReaddir)).toBe(true);
    const failingLstat = {
      readdir: async () => [file("x")],
      lstat: async () => Promise.reject(errno(code)),
    };
    expect(await exceedsBytes("/wt", 1_000_000, failingLstat)).toBe(true);
  });

  it("an unreadable directory on disk counts as over the cap", async () => {
    await mkdir(join(dir, "locked"));
    await writeFile(join(dir, "locked", "f"), "x");
    await chmod(join(dir, "locked"), 0o000);
    try {
      expect(await exceedsBytes(dir, 1_000_000)).toBe(true);
    } finally {
      await chmod(join(dir, "locked"), 0o755);
    }
  });
});

describe("loopback proxy addresses in the runner guard (re-check 3)", () => {
  it.each(["127.0.0.1", "127.1.2.3", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "::FFFF:7f00:1"])("%s is loopback", (ip) => {
    expect(isLoopbackIpLiteral(ip)).toBe(true);
  });
  it.each(["10.0.0.1", "::2", "::ffff:10.0.0.1", "localhost", "", "128.0.0.1"])("%s is not", (ip) => {
    expect(isLoopbackIpLiteral(ip)).toBe(false);
  });
});

describe("runner public guard: trusted proxies (Requirement 11.2)", () => {
  const config = loadRunnerConfig(
    { SEANCE_TARGET_REPO: "/nonexistent", SEANCE_WORKSPACES: "/nonexistent", SEANCE_INVITERS: "alice", SEANCE_DAILY_CREDIT_CAP: "5" },
    "/cwd",
  );

  it("requires a non-empty, loopback-only proxy list on a public deployment", () => {
    for (const proxies of [undefined, [], ["10.0.0.5"], ["127.0.0.1", "192.168.1.1"], ["localhost"]]) {
      expect(() => assertPublicRunner(config, true, proxies)).toThrow(/IRCD_TRUSTED_PROXIES/);
    }
    for (const proxies of [["127.0.0.1"], ["::1"], ["127.0.0.1", "::1", "::ffff:127.0.0.1"]]) {
      expect(() => assertPublicRunner(config, true, proxies)).not.toThrow();
    }
    expect(() => assertPublicRunner(config, false, undefined)).not.toThrow();
  });
});
