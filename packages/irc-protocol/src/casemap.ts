/** Maximum nickname length accepted by the server. */
export const MAX_NICK_LENGTH = 30;
/** Maximum channel name length (including the leading `#`). */
export const MAX_CHANNEL_LENGTH = 50;

/**
 * rfc1459 case-mapping: ASCII letters fold to lowercase, and `[ ] \ ~`
 * are the uppercase forms of `{ } | ^`.
 */
export function irc_lower(s: string): string {
  let out = "";
  for (const ch of s) {
    switch (ch) {
      case "[":
        out += "{";
        break;
      case "]":
        out += "}";
        break;
      case "\\":
        out += "|";
        break;
      case "~":
        out += "^";
        break;
      default:
        out += ch >= "A" && ch <= "Z" ? ch.toLowerCase() : ch;
    }
  }
  return out;
}

const NICK_PATTERN = /^[A-Za-z][A-Za-z0-9\-[\]\\`^{}_]*$/;

/** A nick is 1-30 chars, starts with a letter, then letters, digits or `-[]\`^{}_`. */
export function isValidNick(nick: string): boolean {
  return nick.length >= 1 && nick.length <= MAX_NICK_LENGTH && NICK_PATTERN.test(nick);
}

/** A channel starts with `#`, has a name, and contains no space, comma, BEL, CR, LF or NUL. */
export function isValidChannel(name: string): boolean {
  return (
    name.length >= 2 &&
    name.length <= MAX_CHANNEL_LENGTH &&
    name.startsWith("#") &&
    !/[\s,\x07\x00]/.test(name)
  );
}
