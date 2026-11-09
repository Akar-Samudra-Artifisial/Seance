import type { Clock, TimerSet } from "../clock.js";
import { CreditAccumulator } from "../credits/accumulator.js";
import type { CreditLedger } from "../credits/ledger.js";
import type { HarnessSession, PermissionHandler } from "../harness/harness.js";
import type { RunnerLogger } from "../log.js";
import type { AgentOutput } from "../output/agent-output.js";
import { attachSessionOutput } from "../output/session-output.js";
import { handlePermissionRequest } from "../permissions/handler.js";
import type { IrcHost } from "../ports.js";
import type { AgentProfile } from "../registry/agent-profile.js";
import type { Prompt } from "../session/machine.js";
import { Session } from "../session/session.js";
import type { PromptSink } from "../session/session.js";
import type { WhoisSnapshot } from "../whois/snapshot.js";
import type { WorktreeManager } from "../worktree/worktree-manager.js";

/**
 * What both the invite pipeline and session revival need to open a channel
 * Session: one place for the permission handler, gate, output and credit wiring.
 */
export type ChannelSessionDeps = {
  readonly host: Pick<IrcHost, "modeOf">;
  /** `exceedsCap` and `reset` enable the size check during a turn (public-hardening 14.1). */
  readonly worktrees: Pick<WorktreeManager, "guardBeforePrompt"> & Partial<Pick<WorktreeManager, "exceedsCap" | "reset">>;
  readonly snapshot: WhoisSnapshot;
  readonly ledger: Pick<CreditLedger, "recordMetering">;
  readonly clock: Clock;
  readonly timers: TimerSet;
  readonly logger: RunnerLogger;
  readonly opNotice: (channel: string, text: string) => void;
  /** agent-sandbox Requirement 14 (podman mode only): host-side commit after an `end_turn`. */
  readonly commitTurn?: (agent: string, channel: string) => Promise<void>;
};

/** `session/request_permission` handler for a channel Session confined to `cwd`. */
export function channelPermissionHandler(
  d: Pick<ChannelSessionDeps, "host" | "logger">,
  profile: AgentProfile,
  channel: string,
  cwd: string,
  output: Pick<AgentOutput, "channelNotice">,
): PermissionHandler {
  return (req) =>
    handlePermissionRequest(
      {
        agent: profile.nick,
        channel,
        worktree: cwd,
        isPrivate: false,
        currentMembership: () => d.host.modeOf(channel, profile.nick),
        notifyOps: (text) => {
          output.channelNotice(channel, text);
        },
        logger: d.logger,
      },
      req,
    );
}

/** Builds a channel Session around an open harness session, wiring output and credits. */
export function buildChannelSession(
  d: ChannelSessionDeps,
  profile: AgentProfile,
  channel: string,
  harnessSession: HarnessSession,
  output: AgentOutput,
  isBlocked: (channel: string) => boolean = () => false,
): Session {
  const sink: PromptSink = {
    dropped: (prompt: Prompt, why) => {
      d.logger.warn("prompt dropped", { agent: profile.nick, channel, id: prompt.id, why });
    },
  };
  const commit = d.commitTurn;
  const session = new Session({
    agent: profile.nick,
    channel,
    harnessSession,
    snapshot: d.snapshot,
    timers: d.timers,
    gate: { check: () => d.worktrees.guardBeforePrompt(channel) },
    sink,
    opNotice: d.opNotice,
    isBlocked,
    logger: d.logger,
    ...(commit !== undefined ? { afterTurn: () => commit(profile.nick, channel) } : {}),
  });
  attachSessionOutput({ session, output, clock: d.clock });
  const acc = new CreditAccumulator(`${profile.nick}@${channel}:${harnessSession.id}`, d.logger);
  session.sessionEvents((ev) => {
    if (ev.kind === "metadata") d.ledger.recordMetering(acc, profile.nick, channel, ev.metering);
  });
  watchWorktreeSize(d, profile.nick, channel, session);
  return session;
}

/**
 * public-hardening Requirement 14.1: after each finished tool call the worktree size is checked
 * (one check at a time). Over the cap, the turn is cancelled and, once it ended, the worktree is
 * reset including ignored files, so a disk-filling turn stops early instead of at the commit.
 */
function watchWorktreeSize(d: ChannelSessionDeps, agent: string, channel: string, session: Session): void {
  const exceedsCap = d.worktrees.exceedsCap?.bind(d.worktrees);
  const reset = d.worktrees.reset?.bind(d.worktrees);
  if (exceedsCap === undefined || reset === undefined) return;
  const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
  let checking = false;
  /** A tool-done (or the turn end) arrived while a check ran: check again afterwards. */
  let pending = false;
  /** The running turn was cancelled for size; the worktree is reset when it ends. */
  let oversize = false;
  /** Incremented at every turn end, so a late result knows its turn is over. */
  let turnSeq = 0;

  const resetNow = (): void => {
    reset(channel, { ignored: true }).catch((err: unknown) => {
      d.logger.error("reset after oversize turn failed", { agent, channel, reason: reasonOf(err) });
    });
  };

  // public-hardening re-check: a failed check counts as over the cap (fail closed).
  const check = (): Promise<boolean> =>
    exceedsCap(channel).catch((err: unknown) => {
      d.logger.error("worktree size check failed, treated as over the cap", { agent, channel, reason: reasonOf(err) });
      return true;
    });

  const applyOver = (seq: number): void => {
    if (seq === turnSeq && session.state === "prompting") {
      if (oversize) return;
      oversize = true;
      d.logger.warn("turn cancelled: worktree over the size cap", { agent, channel });
      d.opNotice(channel, `${agent}: turn cancelled in ${channel}, the worktree is over its size cap; it will be reset`);
      session.cancel();
      return;
    }
    // The turn ended before the result arrived: the result still applies.
    d.logger.warn("worktree over the size cap after the turn, reset", { agent, channel });
    d.opNotice(channel, `${agent}: the worktree in ${channel} is over its size cap; it was reset`);
    resetNow();
  };

  const runCheck = (): void => {
    if (checking) {
      pending = true;
      return;
    }
    checking = true;
    pending = false;
    const seq = turnSeq;
    void check()
      .then((over) => {
        if (over) applyOver(seq);
      })
      // applyOver sends notices and cancels; a throw there must be logged, never left unhandled.
      .catch((err: unknown) => {
        d.logger.error("worktree size handling failed", { agent, channel, reason: reasonOf(err) });
      })
      .finally(() => {
        checking = false;
        if (pending) runCheck();
      });
  };

  session.sessionEvents((ev) => {
    if (ev.kind !== "tool-done" || oversize) return;
    runCheck();
  });
  session.turnEnding(() => {
    turnSeq += 1;
    if (oversize) {
      oversize = false;
      resetNow();
      return;
    }
    // One final check for every agent, also those that never commit (no +o, none mode).
    runCheck();
  });
}
