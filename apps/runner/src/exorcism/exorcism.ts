import type { TimerSet } from "../clock.js";
import type { RunnerLogger } from "../log.js";
import type { HostVirtualClient, IrcHost } from "../ports.js";
import { SandboxError } from "../sandbox/errors.js";
import { inviteKey } from "../session/session-manager.js";
import type { SessionManager } from "../session/session-manager.js";
import type { Session } from "../session/session.js";
import { filesReverted, sessionEnded, sessionIdle } from "../services/notices.js";
import type { ResetReport, WorktreeManager } from "../worktree/worktree-manager.js";

/**
 * What removed the Agent: `kick`, its own `part`, `quit` (the `ERROR` from `close()`), or `idle`
 * (the idle timeout of agent-runner Requirement 9.18, handled like a kick).
 */
export type ExorcismTrigger = "kick" | "part" | "quit" | "idle";

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
  /** ChanServ notice to the channel (runner-services Req 6); optional, never throws. */
  readonly chanServ?: (channel: string, text: string) => void;
  /** `CreditLedger.amount(agent, channel)`: the `used` value of `WHOIS 320` (Req 6.3, 7.3). */
  readonly creditsOf?: (agent: string, channel: string) => number;
  /** The idle timeout in minutes, named in the `idle` notice and the PART reason (default 15). */
  readonly idleMinutes?: number;
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

/** The two ChanServ lines of Req 6.1 and 6.3, in that order; the second only when non-zero. */
function sessionEndNotices(
  deps: ExorcismDeps,
  agent: string,
  channel: string,
  wasPrompting: boolean,
  report: ResetReport,
): void {
  const send = deps.chanServ;
  if (send === undefined) return;
  try {
    send(channel, sessionEnded({ cancelled: wasPrompting, sha: report.target }));
    const second = filesReverted({ files: report.filesReverted, credits: deps.creditsOf?.(agent, channel) ?? 0 });
    if (second !== undefined) send(channel, second);
  } catch (err) {
    deps.logger.error("exorcism: session end notice failed", { agent, channel, reason: messageOf(err) });
  }
}

async function run(deps: ExorcismDeps, session: Session, trigger: ExorcismTrigger): Promise<void> {
  const { agent, channel } = session;
  deps.logger.info("exorcism started", { agent, channel, trigger });

  // Req 6.1: "cancelled" only when a prompt was in flight when the exorcism began.
  const wasPrompting = session.state === "prompting";

  // Req 9.18: one extra ChanServ line before the KICK-style notices.
  const idleMinutes = deps.idleMinutes ?? 15;
  if (trigger === "idle" && deps.chanServ !== undefined) {
    try {
      deps.chanServ(channel, sessionIdle({ agent, minutes: idleMinutes }));
    } catch (err) {
      deps.logger.error("exorcism: idle notice failed", { agent, channel, reason: messageOf(err) });
    }
  }

  // 0. Refuse new prompts, drop the queue, never drain.
  session.beginClosing();

  // (a) cancel only while a prompt is in flight.
  if (session.state === "prompting") session.cancel();

  // (b) wait for the Cooldown.
  await waitSettled(session, deps);

  // (c) reset this channel's worktree only; a failure never stops (d) or the leave.
  try {
    const report = await deps.worktrees.reset(channel);
    // Req 6.1 to 6.6: only after a successful reset, only for kick/part, before the agent leaves.
    if (trigger !== "quit" && deps.chanServ !== undefined) {
      sessionEndNotices(deps, agent, channel, wasPrompting, report);
    }
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
      // agent-sandbox Requirement 10.3: a container that could not be removed is reported once.
      if (err instanceof SandboxError && err.kind === "remove-failed") {
        try {
          deps.report(channel, `${agent}: sandbox container not removed in ${channel}; retried at the next sweep`);
        } catch (reportErr) {
          deps.logger.error("exorcism: error report failed", { channel, reason: messageOf(reportErr) });
        }
      }
    }
  }

  // Leave, only for PART/KICK and only if still a member.
  const client = deps.clientOf(agent);
  if (client !== undefined) {
    if (trigger !== "quit" && deps.host.modeOf(channel, agent) !== undefined) {
      try {
        const reason = trigger === "idle" ? `idle for ${String(idleMinutes)} min` : `*** ${agent} has been exorcised`;
        client.dispatch({ command: "PART", params: [channel, reason] });
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
