import { irc_lower } from "@seance/irc-protocol";

/** Longest ban mask kept, in characters (a mask is `nick!user@host`). */
export const BAN_MASK_MAX = 100;
/** Most masks one channel keeps. */
export const BANS_MAX = 50;

/**
 * Normalises the argument of `MODE +b` / `-b` to `nick!user@host` (lower-cased by rfc1459 case-mapping):
 * a bare `nick` becomes `nick!*@*`, `nick!user` becomes `nick!user@*`, `user@host` becomes `*!user@host`.
 * Returns undefined for an empty, too long or malformed argument (spaces, `:`, control characters).
 */
export function normalizeBanMask(input: string): string | undefined {
  const text = input.trim();
  if (text === "" || text.length > BAN_MASK_MAX || /[\s:,\x00-\x1f\x7f]/.test(text)) return undefined;
  const bang = text.indexOf("!");
  const at = text.indexOf("@");
  let mask: string;
  if (bang === -1 && at === -1) mask = `${text}!*@*`;
  else if (bang !== -1 && at === -1) mask = `${text}@*`;
  else if (bang === -1) mask = `*!${text}`;
  else mask = text;
  // Exactly one `!` before one `@`, and no empty part.
  const m = /^([^!@]+)!([^!@]+)@([^!@]+)$/.exec(mask);
  // Runs of `*` mean the same as one; collapsing them keeps stored masks short and cheap to match.
  return m === null ? undefined : irc_lower(mask).replace(/\*{2,}/g, "*");
}

/**
 * Glob match with `*` (any run) and `?` (one character), without a RegExp: two pointers and the position of
 * the last `*`, so the worst case is O(pattern x text) and a hostile mask cannot backtrack (audit 10.13).
 * Counts UTF-16 code units; both sides are already case-mapped.
 */
export function globMatch(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    const pc = pattern[p];
    if (pc === "*") {
      star = p;
      resume = t;
      p += 1;
    } else if (pc !== undefined && (pc === "?" || pc === text[t])) {
      p += 1;
      t += 1;
    } else if (star !== -1) {
      p = star + 1;
      resume += 1;
      t = resume;
    } else {
      return false;
    }
  }
  while (pattern[p] === "*") p += 1;
  return p === pattern.length;
}

/** True when `mask` (already normalised) matches `nick!user@host`. */
export function banMatches(mask: string, nick: string, user: string, host: string): boolean {
  return globMatch(mask, irc_lower(`${nick}!${user}@${host}`));
}

/**
 * True when a channel's bans keep `nick` out. With only a nick known (an invite of an agent that is not
 * connected) a mask counts when its `user@host` part is a pure wildcard, i.e. it names the nick only.
 */
export function isBanned(
  bans: ReadonlySet<string>,
  nick: string,
  user?: string,
  host?: string,
): boolean {
  for (const mask of bans) {
    if (user !== undefined && host !== undefined) {
      if (banMatches(mask, nick, user, host)) return true;
      continue;
    }
    const bang = mask.indexOf("!");
    const rest = mask.slice(bang + 1);
    if (/^\*+@\*+$/.test(rest) && globMatch(mask.slice(0, bang), irc_lower(nick))) return true;
  }
  return false;
}
