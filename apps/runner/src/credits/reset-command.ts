import type { RunnerLogger } from "../log.js";
import type { HostMembership } from "../ports.js";
import type { CreditLedger } from "./ledger.js";

/** The only text that is a reset command, compared after trimming. */
export const RESET_CREDITS_COMMAND = "!reset-credits";

/** True when a private message to an Agent is exactly the reset command. */
export function isResetCreditsCommand(text: string): boolean {
  return text.trim() === RESET_CREDITS_COMMAND;
}

export type ResetCreditsOutcome =
  | { readonly kind: "no-blocked-channel" }
  | { readonly kind: "not-operator"; readonly blocked: readonly string[] }
  | {
      readonly kind: "cleared";
      readonly cleared: readonly string[];
      readonly kept: readonly string[];
    };

export interface ResetCommandDeps {
  readonly ledger: CreditLedger;
  /** Mode of `nick` in `channel` read now; undefined when not a member. */
  readonly modeOf: (channel: string, nick: string) => HostMembership | undefined;
  /** Server-prefixed NOTICE to one client; false when the nick is not connected. */
  readonly noticeTo: (nick: string, text: string) => boolean;
  /** True for registered Agent nicks, which are never Human_Ops (optional). */
  readonly isAgentNick?: (nick: string) => boolean;
  readonly logger?: RunnerLogger;
}

/**
 * `!reset-credits` handler (Req 10.11, 10.12, 10.14, 10.16). Call it only for
 * a private message to the Agent whose trimmed text is the command (see
 * `isResetCreditsCommand`); the caller must not forward that text as a prompt.
 * The handler replies to `sender` with exactly one NOTICE.
 */
export function createResetCreditsHandler(
  deps: ResetCommandDeps,
): (sender: string, agent: string) => ResetCreditsOutcome {
  return function handleResetCredits(sender, agent) {
    const blocked = deps.ledger.blockedChannelsOf(agent);
    let outcome: ResetCreditsOutcome;
    let text: string;

    if (blocked.length === 0) {
      outcome = { kind: "no-blocked-channel" };
      text = `no channel of ${agent} is credit-blocked`;
    } else {
      const senderIsAgent = deps.isAgentNick?.(sender) ?? false;
      const cleared: string[] = [];
      const kept: string[] = [];
      for (const channel of blocked) {
        const isOp = !senderIsAgent && deps.modeOf(channel, sender)?.op === true;
        if (isOp && deps.ledger.clearBlocked(channel)) cleared.push(channel);
        else kept.push(channel);
      }
      if (cleared.length === 0) {
        outcome = { kind: "not-operator", blocked };
        text = `operator rights (+o) are required to reset credits of ${agent}`;
      } else {
        outcome = { kind: "cleared", cleared, kept };
        text = `credit block cleared for ${cleared.join(", ")}`;
        if (kept.length > 0) text += `; still blocked: ${kept.join(", ")}`;
      }
    }

    try {
      deps.noticeTo(sender, text);
    } catch (err) {
      deps.logger?.error("!reset-credits reply failed", {
        sender,
        agent,
        error: String(err),
      });
    }
    return outcome;
  };
}
