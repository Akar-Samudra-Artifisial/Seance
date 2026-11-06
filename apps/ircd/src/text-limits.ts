/** Maximum wire length of one message, CRLF included, in UTF-8 bytes. */
export const MAX_LINE_BYTES = 512;

/** Longest topic stored and advertised as `TOPICLEN` in `005`, in UTF-8 bytes. */
export const TOPICLEN = 300;

/** Longest `KICK` reason used and advertised as `KICKLEN` in `005`, in UTF-8 bytes. */
export const KICKLEN = 300;

/** Longest `AWAY` message stored and advertised as `AWAYLEN` in `005`, in UTF-8 bytes. */
export const AWAYLEN = 200;

/**
 * Replace CR, LF and NUL with a space so untrusted text can never make
 * `serialize()` throw.
 */
export function stripControl(text: string): string {
  return text.replace(/[\r\n\0]/g, " ");
}

/** Trim text to at most `maxBytes` UTF-8 bytes without splitting a code point. */
export function clampBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let out = "";
  let bytes = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, "utf8");
    if (bytes + size > maxBytes) break;
    out += ch;
    bytes += size;
  }
  return out;
}

/**
 * Trim the trailing parameter of a message so the serialized line (always
 * written as `:text`) fits in 512 bytes including CRLF.
 *
 * `leading` are the params before the trailing one. The budget is computed from
 * the real prefix and params, because host length varies (IPv6, virtual hosts).
 */
export function clampTrailing(
  prefix: string | undefined,
  command: string,
  leading: readonly string[],
  text: string,
): string {
  const head = [prefix === undefined ? undefined : `:${prefix}`, command, ...leading]
    .filter((part): part is string => part !== undefined)
    .join(" ");
  // head + " :" + text + CRLF
  const budget = MAX_LINE_BYTES - 2 - 2 - Buffer.byteLength(head, "utf8");
  return clampBytes(text, Math.max(0, budget));
}

/**
 * Cleaned AWAY text: control chars replaced, trimmed, clamped to AWAYLEN, no
 * trailing space. `""` means "not away".
 */
export function normalizeAway(text: string | undefined): string {
  if (text === undefined) return "";
  return clampBytes(stripControl(text).trim(), AWAYLEN).trimEnd();
}
