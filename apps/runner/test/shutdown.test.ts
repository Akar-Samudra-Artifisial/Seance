import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { TimerSet } from "../src/clock.js";
import type { RunnerLogger } from "../src/log.js";
import { createShutdown, KILL_GRACE_MS, type ShutdownDeps } from "../src/shutdown.js";
import { ManualClock } from "./fixtures/manual-clock.js";
import { withTempRepo } from "./fixtures/temp-repo.js";

const run = promisify(execFile);

const silentLogger: RunnerLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface Env {
  readonly clock: ManualClock;
  readonly calls: string[];
  readonly timers: TimerSet;
  readonly deps: ShutdownDeps;
  readonly state: { shuttingDown: boolean; processes: number };
}

const makeEnv = (override: Partial<ShutdownDeps> = {}): Env => {
  const clock = new ManualClock();
  const timers = new TimerSet(clock);
  const calls: string[] = [];
  const state = { shuttingDown: false, processes: 2 };
  // A pending session timer, as the session manager would own.
  timers.set(() => undefined, 60_000);
  const deps: ShutdownDeps = {
    logger: silentLogger,
    clock,
    markShuttingDown: () => {
      calls.push("mark");
      state.shuttingDown = true;
    },
    cancelAndCloseSessions: () => {
      calls.push("sessions");
      return Promise.resolve();
    },
    disposeHarness: () => {
      calls.push("dispose");
      state.processes = 0;
      return Promise.resolve();
    },
    killRemainingProcesses: () => {
      calls.push("kill");
    },
    closeVirtualClients: (reason) => {
      calls.push(`quit:${reason}`);
    },
    timerSets: [timers],
    unsubscribers: [
      () => {
        calls.push("unsubscribe");
      },
    ],
    flushLedger: () => {
      calls.push("flush");
      return Promise.resolve();
    },
    liveProcessCount: () => state.processes,
    quitReason: "bye",
    ...override,
  };
  return { clock, calls, timers, deps, state };
};

describe("shutdown", () => {
  it("runs the steps in the documented order (Req 11.1, 11.3, 11.6, 11.7)", async () => {
    const env = makeEnv();
    const report = await createShutdown(env.deps).run();
    expect(env.calls).toEqual([
      "mark",
      "sessions",
      "dispose",
      "quit:bye",
      "unsubscribe",
      "flush",
    ]);
    expect(report.errors).toEqual([]);
  });

  it("waits for the session cooldown before terminating processes (Req 11.3)", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sessionsStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      sessionsStarted = resolve;
    });
    const env = makeEnv({
      cancelAndCloseSessions: async () => {
        env.calls.push("sessions:start");
        sessionsStarted();
        await gate;
        env.calls.push("sessions:done");
      },
    });
    const pending = createShutdown(env.deps).run();
    await started;
    expect(env.calls).toEqual(["mark", "sessions:start"]);
    release();
    await pending;
    expect(env.calls.indexOf("sessions:done")).toBeLessThan(env.calls.indexOf("dispose"));
  });

  it("flips the shutdown flag synchronously so invites and prompts are refused (Req 11.1, 11.2)", async () => {
    const env = makeEnv();
    const sd = createShutdown(env.deps);
    expect(sd.isShuttingDown()).toBe(false);
    expect(env.state.shuttingDown).toBe(false);
    const pending = sd.run();
    expect(sd.isShuttingDown()).toBe(true);
    await pending;
    // The mark step ran before any session or process work started.
    expect(env.calls[0]).toBe("mark");
    expect(env.state.shuttingDown).toBe(true);
  });

  it("ignores a second request and runs the sequence once (Req 11.8)", async () => {
    const env = makeEnv();
    const sd = createShutdown(env.deps);
    const first = sd.run();
    const second = sd.run();
    expect(second).toBe(first);
    await first;
    const third = sd.run();
    expect(third).toBe(first);
    await third;
    expect(env.calls.filter((c) => c === "mark")).toHaveLength(1);
    expect(env.calls.filter((c) => c === "dispose")).toHaveLength(1);
    expect(env.calls.filter((c) => c === "flush")).toHaveLength(1);
  });

  it("leaves no timers and no processes behind (Req 11.7)", async () => {
    const env = makeEnv();
    expect(env.timers.size).toBe(1);
    const report = await createShutdown(env.deps).run();
    expect(env.timers.size).toBe(0);
    expect(env.clock.pending).toBe(0);
    expect(report.remainingTimers).toBe(0);
    expect(report.remainingProcesses).toBe(0);
  });

  it("reports an error when a process survives (Req 11.7)", async () => {
    const env = makeEnv({ liveProcessCount: () => 1 });
    const report = await createShutdown(env.deps).run();
    expect(report.remainingProcesses).toBe(1);
    expect(report.errors.map((e) => e.message).join("\n")).toMatch(/1 process/);
  });

  it("sends SIGKILL 5 s after SIGTERM to a process that ignores it (Req 11.5)", async () => {
    let exit: () => void = () => undefined;
    let disposeStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      disposeStarted = resolve;
    });
    const env = makeEnv({
      disposeHarness: () => {
        env.calls.push("dispose");
        disposeStarted();
        return new Promise<void>((resolve) => {
          exit = () => {
            env.state.processes = 0;
            resolve();
          };
        });
      },
    });
    const pending = createShutdown(env.deps).run();
    await started;
    expect(env.calls).toContain("dispose");
    env.clock.advance(KILL_GRACE_MS - 1);
    expect(env.calls).not.toContain("kill");
    env.clock.advance(1);
    expect(env.calls).toContain("kill");
    exit();
    const report = await pending;
    expect(report.errors).toEqual([]);
    expect(env.clock.pending).toBe(0);
  });

  it("does not send SIGKILL when processes exit within the grace period (Req 11.5)", async () => {
    const env = makeEnv();
    await createShutdown(env.deps).run();
    env.clock.advance(KILL_GRACE_MS * 2);
    expect(env.calls).not.toContain("kill");
  });

  it("keeps going after a step fails and reports the error", async () => {
    const env = makeEnv({
      cancelAndCloseSessions: () => Promise.reject(new Error("cancel blew up")),
    });
    const report = await createShutdown(env.deps).run();
    expect(report.errors.map((e) => e.message)).toContain("cancel blew up");
    expect(env.calls).toContain("dispose");
    expect(env.calls).toContain("flush");
  });

  it("does not touch a worktree with uncommitted work (Req 11.9)", async () => {
    await withTempRepo(async (repo) => {
      const file = join(repo.path, "README.md");
      await writeFile(file, "# edited, not committed\n", "utf8");
      await writeFile(join(repo.path, "new.txt"), "untracked\n", "utf8");
      const status = async (): Promise<string> =>
        (await run("git", ["status", "--porcelain"], { cwd: repo.path })).stdout;
      const before = await status();
      expect(before).toContain("README.md");

      await createShutdown(makeEnv().deps).run();

      expect(await status()).toBe(before);
      expect(await readFile(file, "utf8")).toBe("# edited, not committed\n");
      expect(await readFile(join(repo.path, "new.txt"), "utf8")).toBe("untracked\n");
    });
  });
});
