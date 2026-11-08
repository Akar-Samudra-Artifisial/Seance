// Agent-to-agent loop guard (runner-services Requirement 11, design D13 to D15). Pure: no I/O, no
// clock. SessionManager asks it before an Agent's channel line becomes another Agent's prompt.
import { irc_lower } from "@seance/irc-protocol";

/** Prompts an Agent may receive from other Agents in one channel before a human speaks again. */
export const AGENT_REPLY_LIMIT = 3;

/** IRC formatting removed as whole sequences: `\x03` with its colour digits, then other controls. */
function stripFormatting(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x03(?:\d{1,2}(?:,\d{1,2})?)?/g, "").replace(/[\u0000-\u001F\u007F]/g, "");
}

/**
 * Nick characters of Requirement 11.1 (`A-Z a-z 0-9 - [ ] \ ` ^ { } | _`): a mention needs a
 * non-nick boundary. `~` is not one, so `~reviewer` mentions reviewer.
 */
const NICK_CHAR = /[A-Za-z0-9\-[\]\\`^{}|_]/;

/**
 * True when `text`, with IRC formatting removed, contains `nick` as a whole word under rfc1459
 * case-mapping (Requirement 11.1). `reviewer:`, `@reviewer`, `REVIEWER,` and `\x0312reviewer` match;
 * `reviewers` and `xreviewer` do not.
 */
export function mentionsNick(text: string, nick: string): boolean {
  if (nick === "") return false;
  const plainText = stripFormatting(text);
  // irc_lower maps one code unit to one code unit, so indexes in `hay` and `plainText` agree. The
  // boundary is read from the original text: lowering would turn `~` into `^`, a nick character.
  const hay = irc_lower(plainText);
  const needle = irc_lower(nick);
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at === -1) return false;
    const before = at === 0 ? "" : plainText.charAt(at - 1);
    const after = plainText.charAt(at + needle.length);
    if ((before === "" || !NICK_CHAR.test(before)) && (after === "" || !NICK_CHAR.test(after))) return true;
    from = at + 1;
  }
}

export type LoopDecision = "deliver" | "not-mentioned" | "limit";

/**
 * Counts, per (recipient Agent, channel), the prompts that came from other Agents since the last
 * human line in the channel. Keys use `irc_lower`; a channel's entry is dropped on every human
 * line, so the state never grows beyond the pairs active since then.
 */
export class AgentLoopGuard {
  readonly #limit: number;
  /** channel key -> recipient key -> count */
  readonly #counts = new Map<string, Map<string, number>>();
  /** channel key -> recipient keys already logged for the current limit episode */
  readonly #logged = new Map<string, Set<string>>();

  constructor(limit: number = AGENT_REPLY_LIMIT) {
    if (!Number.isInteger(limit) || limit < 0) throw new RangeError(`agent reply limit must be a non-negative integer, got ${String(limit)}`);
    this.#limit = limit;
  }

  get limit(): number {
    return this.#limit;
  }

  /**
   * A line from a voiced or op human in `channel` (Requirement 11.4): every count of the channel
   * goes back to zero. The caller decides who counts as such a human.
   */
  humanSpoke(channel: string): void {
    const key = irc_lower(channel);
    this.#counts.delete(key);
    this.#logged.delete(key);
  }

  /**
   * An Agent's line in `channel`, about to be offered to `recipient` (Requirement 11.1, 11.3).
   * Decides, and on "deliver" counts it.
   */
  decide(channel: string, recipient: string, text: string): LoopDecision {
    if (!mentionsNick(text, recipient)) return "not-mentioned";
    const channelKey = irc_lower(channel);
    const recipientKey = irc_lower(recipient);
    const counts = this.#counts.get(channelKey) ?? new Map<string, number>();
    const used = counts.get(recipientKey) ?? 0;
    if (used >= this.#limit) return "limit";
    counts.set(recipientKey, used + 1);
    this.#counts.set(channelKey, counts);
    return "deliver";
  }

  /**
   * Takes back one count of a "deliver" decision whose prompt never reached an Agent (a revival
   * that failed), so only prompts that were actually handed to a Session stay counted.
   */
  release(channel: string, recipient: string): void {
    const channelKey = irc_lower(channel);
    const counts = this.#counts.get(channelKey);
    if (counts === undefined) return;
    const recipientKey = irc_lower(recipient);
    const used = counts.get(recipientKey) ?? 0;
    if (used <= 1) counts.delete(recipientKey);
    else counts.set(recipientKey, used - 1);
    if (counts.size === 0) this.#counts.delete(channelKey);
  }

  /** True when the guard holds counts for `channel` (tests, diagnostics). */
  hasChannel(channel: string): boolean {
    return this.#counts.has(irc_lower(channel));
  }

  /** Prompts `recipient` got from Agents in `channel` since the last human line. */
  count(channel: string, recipient: string): number {
    return this.#counts.get(irc_lower(channel))?.get(irc_lower(recipient)) ?? 0;
  }

  /** True the first time a limit is hit in the current episode, so the log says it once. */
  firstLimitHit(channel: string, recipient: string): boolean {
    const channelKey = irc_lower(channel);
    const logged = this.#logged.get(channelKey) ?? new Set<string>();
    const recipientKey = irc_lower(recipient);
    if (logged.has(recipientKey)) return false;
    logged.add(recipientKey);
    this.#logged.set(channelKey, logged);
    return true;
  }

  /** Number of (recipient, channel) entries held; bounded by the pairs seen since the last human line. */
  get size(): number {
    let n = 0;
    for (const m of this.#counts.values()) n += m.size;
    return n;
  }

  /** The channel has no Session any more (Requirement 11.5): drop its entries. */
  forgetChannel(channel: string): void {
    const key = irc_lower(channel);
    this.#counts.delete(key);
    this.#logged.delete(key);
  }

  /** Shutdown (Requirement 11.5). */
  clear(): void {
    this.#counts.clear();
    this.#logged.clear();
  }
}
