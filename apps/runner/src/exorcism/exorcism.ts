import type { TimerSet } from "../clock.js";
import type { RunnerLogger } from "../log.js";
import type { HostVirtualClient, IrcHost } from "../ports.js";
import { inviteKey } from "../session/session-manager.js";
import type { SessionManager } from "../session/session-manager.js";
import type { Session } from "../session/session.js";
import type { WorktreeManager } from "../worktree/worktree-manager.js";

/** What removed the Agent: `kick`, its own `part`, or `quit` (the `ERROR` from `close()`). */
export type ExorcismTrigger = "kick" | "part" | "quit";

export type ExorcismDeps = {
  readonly host: Pick<IrcHost, "modeOf">;
  readonly sessions: Pick<SessionManager, "removeChannelSession">;
  readonly worktrees: Pick<WorktreeManager, "reset">;
  readonly timers: TimerSet;
  readonly logger: RunnerLogger;
  /** The Agent's own virtual client for `nick`, or undefined when it is gone. */
  readonly clientOf: (agent: string) => HostVirtualClient | undefined;
  /** Reports an error naming the channel and cause (one NOTICE per Human_Op, plus the log). */
  readonly report: (channel: string, text: string) => void;
  /** Forgets the harness session after the Session is closed (optional). */
  readonly closeHarnessSession?: (session: Session) => Promise<void>;
  /** Poll interval while waiting for the Cooldown to elapse. */
  readonly pollMs?: number;
  /** Upper bound for the Cooldown wait; the exorcism proceeds afterwards. */
  readonly maxWaitMs?: number;
};

const DEFAULT_POLL_MS = 25;
const DEFAULT_MAX_WAIT_MS = 30_000;

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Step (b): resolves once the Session is `idle` or `closed` (or the bound passes). */
function waitSettled(session: Session, deps: ExorcismDeps): Promise<void> {
  const poll = deps.pollMs ?? DEFAULT_POLL_MS;
  const max = deps.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const settled = (): boolean => session.state === "idle" || session.state === "closed";
  if (settled()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let waited = 0;
    const tick = (): void => {
      if (settled()) {
        resolve();
        return;
      }
      waited += poll;
      if (waited >= max) {
        deps.logger.warn("exorcism: cooldown wait bound reached", {
          agent: session.agent,
          channel: session.channel,
          state: session.state,
        });
        resolve();
        return;
      }
      deps.timers.set(tick, poll);
    };
    deps.timers.set(tick, poll);
  });
}

async function run(deps: ExorcismDeps, session: Session, trigger: ExorcismTrigger): Promise<void> {
  const { agent, channel } = session;
  deps.logger.info("exorcism started", { agent, channel, trigger });

  // 0. Refuse new prompts, drop the queue, never drain.
  session.beginClosing();

  // (a) cancel only while a prompt is in flight.
  if (session.state === "prompting") session.cancel();

  // (b) wait for the Cooldown.
  await waitSettled(session, deps);

  // (c) reset this channel's worktree only; a failure never stops (d) or the leave.
  try {
    await deps.worktrees.reset(channel);
  } catch (err) {
    const cause = messageOf(err);
    deps.logger.error("exorcism: worktree reset failed", { agent, channel, reason: cause });
    try {
      deps.report(channel, `${agent}: worktree reset failed in ${channel}: ${cause}`);
    } catch (reportErr) {
      deps.logger.error("exorcism: error report failed", { channel, reason: messageOf(reportErr) });
    }
  }

  // (d) close the Session (idempotent when the process-exit path already did).
  session.close("exorcism");
  if (deps.closeHarnessSession !== undefined) {
    try {
      await deps.closeHarnessSession(session);
    } catch (err) {
      deps.logger.error("exorcism: harness session close failed", {
        agent,
        channel,
        reason: messageOf(err),
      });
    }
  }

  // Leave, only for PART/KICK and only if still a member.
  const client = deps.clientOf(agent);
  if (client !== undefined) {
    if (trigger !== "quit" && deps.host.modeOf(channel, agent) !== undefined) {
      try {
        client.dispatch({ command: "PART", params: [channel, `*** ${agent} has been exorcised`] });
      } catch (err) {
        deps.logger.error("exorcism: leave failed", { agent, channel, reason: messageOf(err) });
      }
    }
    try {
      client.setAway();
    } catch (err) {
      deps.logger.error("exorcism: clearing AWAY failed", { agent, channel, reason: messageOf(err) });
    }
  }

  // Release the Invite_Key.
  deps.sessions.removeChannelSession(agent, channel);
  deps.logger.info("exorcism finished", { agent, channel, trigger });
}

/**
 * Creates `exorcise(session, trigger)`: ordered steps, single-flight per
 * Invite_Key (a second trigger returns the first call's promise). Never
 * rejects: every failure is reported and the Session ends `closed`.
 */
export function createExorcist(
  deps: ExorcismDeps,
): (session: Session, trigger: ExorcismTrigger) => Promise<void> {
  const inFlight = new Map<string, Promise<void>>();
  return (session, trigger) => {
    const key = inviteKey(session.agent, session.channel);
    const existing = inFlight.get(key);
    if (existing !== undefined) return existing;
    const promise = run(deps, session, trigger)
      .catch((err: unknown) => {
        deps.logger.error("exorcism failed", {
          agent: session.agent,
          channel: session.channel,
          reason: messageOf(err),
        });
        session.close("exorcism"); // never leave the Session non-closed
        deps.sessions.removeChannelSession(session.agent, session.channel);
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, promise);
    return promise;
  };
}
