/** Marker that replaces any `untrusted` tag form found in text. Contains no `<`. */
export const NEUTRALISED_MARKER = "[untrusted-tag]";

export const UNTRUSTED_OPEN = "<untrusted>";
export const UNTRUSTED_CLOSE = "</untrusted>";

/**
 * Matches every opening or closing `untrusted` tag form: `<untrusted>`, `</untrusted>`,
 * `< / UnTrusted >`, and also a bare `<untrusted` with no `>` (which could otherwise
 * combine with following text). The closing `>` is consumed when present.
 */
const TAG_PATTERN = /<\s*\/?\s*untrusted\s*>?/gi;

/**
 * Replace every `untrusted` tag form with a marker that has no `<`, so the text can neither
 * close nor reopen a wrapper. The marker starts with `[`, so a replacement can never form a
 * new match with preceding characters.
 */
export function neutralise(text: string): string {
  return text.replace(TAG_PATTERN, NEUTRALISED_MARKER);
}

/** Wrap text in exactly one Untrusted_Wrapper, neutralising any tag forms inside it. */
export function wrapUntrusted(text: string): string {
  return `${UNTRUSTED_OPEN}${neutralise(text)}${UNTRUSTED_CLOSE}`;
}
