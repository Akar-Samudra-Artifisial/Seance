/** Maximum IRC line length in bytes, including the terminating CRLF. */
export const LINE_LIMIT = 512;

/** Bytes reserved for `\x03NN` (3), the reset `\x0F` (1) and 2 spare. */
const DECORATION_RESERVE = 6;
const CRLF_BYTES = 2;
const COLOR_RESET = "\x0F";
/** Longest UTF-8 encoding of one code point; a smaller budget cannot make progress. */
const MAX_CODE_POINT_BYTES = 4;

/**
 * Bytes available for text in one `PRIVMSG` line, given the exact prefix the
 * ircd adds (`nick!user@host`) and the target.
 */
export function budgetFor(prefix: string, target: string): number {
  const head = `:${prefix} PRIVMSG ${target} :`;
  return LINE_LIMIT - CRLF_BYTES - Buffer.byteLength(head, "utf8") - DECORATION_RESERVE;
}

/**
 * Removes every C0 control (U+0000..U+001F, including CR, LF, ESC and the IRC colour/format codes)
 * and DEL. The runner adds its own colour codes after this step, so agent text can never carry any.
 */
export function stripControls(text: string): string {
  // A colour code is `\x03` plus up to two digits and an optional `,NN` background: remove it whole,
  // otherwise `\x0312The veil` would leave a literal "12" in front of the text (audit 10.6).
  return (
    text
      // eslint-disable-next-line no-control-regex
      .replace(/\x03(?:\d{1,2}(?:,\d{1,2})?)?/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001F\u007F]/g, "")
  );
}

function colorCode(color: number): string {
  if (!Number.isInteger(color) || color < 0 || color > 99) {
    throw new RangeError(`color must be an integer in 0..99, got ${String(color)}`);
  }
  return `\x03${String(color).padStart(2, "0")}`;
}

/**
 * Turns agent text into colored pieces whose serialized line fits the budget.
 * Removes CR, LF and NUL, drops whitespace-only text and cuts only at code point
 * boundaries. Lone surrogates count as the 3 bytes they encode to.
 */
export function formatLines(text: string, color: number, budget: number): readonly string[] {
  if (!Number.isFinite(budget) || budget < MAX_CODE_POINT_BYTES) {
    throw new RangeError(`budget must be at least ${String(MAX_CODE_POINT_BYTES)} bytes, got ${String(budget)}`);
  }
  const open = colorCode(color);
  const clean = stripControls(text);
  if (clean.trim() === "") return [];

  const lines: string[] = [];
  let piece = "";
  let bytes = 0;
  for (const cp of clean) {
    const size = Buffer.byteLength(cp, "utf8");
    if (bytes + size > budget) {
      lines.push(`${open}${piece}${COLOR_RESET}`);
      piece = "";
      bytes = 0;
    }
    piece += cp;
    bytes += size;
  }
  if (piece !== "") lines.push(`${open}${piece}${COLOR_RESET}`);
  return lines;
}
