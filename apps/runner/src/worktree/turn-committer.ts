/**
 * Host-side commit after an agent turn (agent-sandbox Requirement 14, design D17). The container has
 * no git metadata; the runner commits for a `+o` agent with the hardened git of the WorktreeManager.
 */
import type { RunnerLogger } from "../log.js";
import type { IrcHost } from "../ports.js";
import { turnCommitted } from "../services/notices.js";
import type { WorktreeManager } from "./worktree-manager.js";

export type TurnCommitterDeps = {
  readonly host: Pick<IrcHost, "modeOf">;
  readonly worktrees: Pick<WorktreeManager, "commitTurn">;
  readonly logger: RunnerLogger;
  /** ChanServ notice to the channel; optional. */
  readonly chanServ?: (channel: string, text: string) => void;
  /** One NOTICE per Human_Op of the channel. */
  readonly opNotice: (channel: string, text: string) => void;
};

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Returns `commit(agent, channel)`; it never rejects (a failure is logged and reported). */
export function createTurnCommitter(d: TurnCommitterDeps): (agent: string, channel: string) => Promise<void> {
  return async (agent, channel) => {
    // Requirement 14.1: only an op may write; the mode is read when the turn ends.
    if (d.host.modeOf(channel, agent)?.op !== true) {
      d.logger.debug("host commit skipped: agent is not +o", { agent, channel });
      return;
    }
    try {
      const result = await d.worktrees.commitTurn(channel, agent);
      switch (result.kind) {
        case "clean":
          return;
        case "refused":
          d.logger.warn("host commit refused: protected config in the worktree", { agent, channel, paths: result.paths });
          return;
        case "reset":
          // public-hardening Requirement 9: the turn's work was discarded, not committed.
          d.logger.warn("host commit skipped: worktree reset", { agent, channel, reason: result.reason });
          try {
            d.opNotice(channel, `${agent}: turn not committed in ${channel}, worktree reset (${result.reason})`);
          } catch (err) {
            d.logger.error("reset notice failed", { agent, channel, reason: messageOf(err) });
          }
          return;
        case "committed":
          d.logger.info("host commit made", { agent, channel, sha: result.sha, files: result.files });
          try {
            d.chanServ?.(channel, turnCommitted({ agent, sha: result.sha, files: result.files }));
          } catch (err) {
            d.logger.error("commit notice failed", { agent, channel, reason: messageOf(err) });
          }
          return;
      }
    } catch (err) {
      d.logger.error("host commit failed", { agent, channel, reason: messageOf(err) });
      try {
        d.opNotice(channel, `${agent}: commit failed in ${channel} (see the runner log)`);
      } catch (noticeErr) {
        d.logger.error("commit failure notice failed", { channel, reason: messageOf(noticeErr) });
      }
    }
  };
}
