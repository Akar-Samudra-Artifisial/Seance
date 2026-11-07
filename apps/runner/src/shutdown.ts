import { TimerSet, type Clock } from "./clock.js";
import type { RunnerLogger } from "./log.js";

/** Grace period between SIGTERM and SIGKILL (Req 11.5). */
export const KILL_GRACE_MS = 5_000;

export type Unsubscribe = () => void;

/**
 * Everything the shutdown sequence touches, injected so it can be tested
 * without the real SessionManager, harness, ledger or ircd host.
 */
export interface ShutdownDeps {
  readonly logger: RunnerLogger;
  readonly clock: Clock;
  /** Step 1: flips the runner into `shuttingDown` (resolver → false, invites and enqueues refused). */
  readonly markShuttingDown: () => void;
  /**
   * Step 2: for every `prompting` session do `begin-closing` + `cancel`, then
   * wait until each reaches `idle` (cooldown). Closes private sessions too.
   */
  readonly cancelAndCloseSessions: () => Promise<void>;
  /** Step 3: SIGTERM every agent process; resolves when all have exited. */
  readonly disposeHarness: () => Promise<void>;
  /** Called when `disposeHarness` is still pending `killGraceMs` after it started: SIGKILL survivors. */
  readonly killRemainingProcesses: () => void;
  /** Step 4: QUIT every agent virtual client so the agent leaves all channels. */
  readonly closeVirtualClients: (reason: string) => Promise<void> | void;
  /** Step 5: every TimerSet owned by the runner's components. */
  readonly timerSets: readonly TimerSet[];
  /** Step 5: unsubscribe from host events (and any other listeners). */
  readonly unsubscribers: readonly Unsubscribe[];
  /** Step 5: flush the SessionStore (ledger) once. */
  readonly flushLedger: () => Promise<void>;
  /** Live child-process count, for the final assertion. */
  readonly liveProcessCount: () => number;
  readonly killGraceMs?: number;
  readonly quitReason?: string;
}

export interface ShutdownReport {
  /** Errors from steps that failed; later steps still ran. */
  readonly errors: readonly Error[];
  readonly remainingTimers: number;
  readonly remainingProcesses: number;
}

export interface Shutdown {
  /** Idempotent: the first call runs the sequence, later calls return the same promise (Req 11.8). */
  readonly run: () => Promise<ShutdownReport>;
  readonly isShuttingDown: () => boolean;
}

const toError = (e: unknown): Error =>
  e instanceof Error ? e : new Error(String(e));

export const createShutdown = (deps: ShutdownDeps): Shutdown => {
  const graceMs = deps.killGraceMs ?? KILL_GRACE_MS;
  const quitReason = deps.quitReason ?? "Runner shutting down";
  let started: Promise<ShutdownReport> | undefined;

  const execute = async (): Promise<ShutdownReport> => {
    const errors: Error[] = [];
    const step = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
      try {
        await fn();
      } catch (cause) {
        const err = toError(cause);
        errors.push(err);
        deps.logger.error(`shutdown step failed: ${name}: ${err.message}`, { step: name });
      }
    };

    // 1. Refuse new work (Req 11.1, 11.2).
    await step("mark-shutting-down", deps.markShuttingDown);

    // 2. Cancel prompting sessions and wait for their cooldown (Req 11.3).
    await step("close-sessions", deps.cancelAndCloseSessions);

    // 3. SIGTERM, then SIGKILL if still alive after the grace period (Req 11.4, 11.5).
    await step("dispose-harness", async () => {
      const killTimers = new TimerSet(deps.clock);
      killTimers.set(() => {
        deps.logger.warn("agent processes still alive after SIGTERM; sending SIGKILL", {
          graceMs,
        });
        try {
          deps.killRemainingProcesses();
        } catch (cause) {
          const err = toError(cause);
          errors.push(err);
          deps.logger.error(`SIGKILL failed: ${err.message}`);
        }
      }, graceMs);
      try {
        await deps.disposeHarness();
      } finally {
        killTimers.clearAll();
      }
    });

    // 4. Agents leave all channels (Req 11.6).
    await step("close-virtual-clients", () => deps.closeVirtualClients(quitReason));

    // 5. Timers, host subscriptions, ledger flush (Req 11.7).
    await step("clear-timers", () => {
      for (const set of deps.timerSets) set.clearAll();
    });
    await step("unsubscribe", () => {
      for (const off of deps.unsubscribers) {
        try {
          off();
        } catch (cause) {
          const err = toError(cause);
          errors.push(err);
          deps.logger.error(`unsubscribe failed: ${err.message}`);
        }
      }
    });
    await step("flush-ledger", deps.flushLedger);

    const remainingTimers = deps.timerSets.reduce((n, s) => n + s.size, 0);
    const remainingProcesses = deps.liveProcessCount();
    if (remainingTimers > 0 || remainingProcesses > 0) {
      const err = new Error(
        `shutdown incomplete: ${String(remainingTimers)} timer(s) and ${String(remainingProcesses)} process(es) remain`,
      );
      errors.push(err);
      deps.logger.error(err.message, { remainingTimers, remainingProcesses });
    }
    // Worktrees are deliberately left untouched (Req 11.9).
    return { errors, remainingTimers, remainingProcesses };
  };

  return {
    run: () => {
      started ??= execute();
      return started;
    },
    isShuttingDown: () => started !== undefined,
  };
};
