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
  readonly worktrees: Pick<WorktreeManager, "guardBeforePrompt">;
  readonly snapshot: WhoisSnapshot;
  readonly ledger: Pick<CreditLedger, "recordMetering">;
  readonly clock: Clock;
  readonly timers: TimerSet;
  readonly logger: RunnerLogger;
  readonly opNotice: (channel: string, text: string) => void;
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
  });
  attachSessionOutput({ session, output, clock: d.clock });
  const acc = new CreditAccumulator(`${profile.nick}@${channel}:${harnessSession.id}`, d.logger);
  session.sessionEvents((ev) => {
    if (ev.kind === "metadata") d.ledger.recordMetering(acc, profile.nick, channel, ev.metering);
  });
  return session;
}
