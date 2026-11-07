import { irc_lower } from "./casemap.js";

// Characters that can be part of a nick (RFC 2812: letters, digits, special `[ ] \ ` _ ^ { | }`, and `-`).
const NICK_CHAR = /^[A-Za-z0-9\-[\]\\`^{|}_]$/;

function isNickChar(ch: string | undefined): boolean {
  return ch !== undefined && NICK_CHAR.test(ch);
}

export interface MentionSegment {
  readonly text: string;
  /** True for a whole-word occurrence of the nick. */
  readonly hit: boolean;
}

/**
 * Split `text` into plain and nick segments (whole-word, rfc1459 case-mapping).
 * Concatenating the segment texts always gives back `text`.
 */
export function mentionSegments(text: string, ownNick: string): readonly MentionSegment[] {
  if (ownNick.length === 0 || text.length === 0) return [{ text, hit: false }];
  const haystack = irc_lower(text);
  const needle = irc_lower(ownNick);
  const out: MentionSegment[] = [];
  let last = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    const before = at > 0 ? haystack[at - 1] : undefined;
    const after = haystack[at + needle.length];
    if (isNickChar(before) || isNickChar(after)) {
      from = at + 1;
      continue;
    }
    if (at > last) out.push({ text: text.slice(last, at), hit: false });
    out.push({ text: text.slice(at, at + needle.length), hit: true });
    last = at + needle.length;
    from = last;
  }
  if (last < text.length) out.push({ text: text.slice(last), hit: false });
  return out.length === 0 ? [{ text, hit: false }] : out;
}

/**
 * True when `ownNick` appears in `text` as a whole word under rfc1459 case-mapping.
 * The nick must be delimited on both sides by the start/end of the text or a
 * character that cannot be part of a nick. Whether the line was sent by the
 * own nick is the caller's concern.
 */
export function isMention(text: string, ownNick: string): boolean {
  if (ownNick.length === 0) return false;
  const haystack = irc_lower(text);
  const needle = irc_lower(ownNick);
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    const before = at > 0 ? haystack[at - 1] : undefined;
    const after = haystack[at + needle.length];
    if (!isNickChar(before) && !isNickChar(after)) return true;
    from = at + 1;
  }
}
