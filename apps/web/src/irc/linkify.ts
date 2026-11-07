export type Segment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "link"; readonly text: string; readonly href: string };

// Candidate: `http://` or `https://` at a word boundary, then anything that is
// not whitespace, a control character, `<`, `>` or `"`.
const CANDIDATE = /https?:\/\/[^\s\u0000-\u001f\u007f<>"]+/g;

const TRAILING_PUNCT = new Set([".", ",", ";", ":", "!", "?", "'", "*"]);
const CLOSERS: Readonly<Record<string, string>> = { ")": "(", "]": "[", "}": "{" };

function count(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

/** Drops trailing punctuation and unbalanced closing brackets from a candidate. */
function trimTrailing(candidate: string): string {
  let end = candidate.length;
  while (end > 0) {
    const last = candidate[end - 1] as string;
    const opener = CLOSERS[last];
    if (TRAILING_PUNCT.has(last)) {
      end--;
    } else if (opener !== undefined) {
      const body = candidate.slice(0, end);
      if (count(body, last) > count(body, opener)) end--;
      else break;
    } else {
      break;
    }
  }
  return candidate.slice(0, end);
}

// Scheme, then a non-empty host: at least one character that is not a
// delimiter (`/ ? # @ :`), optionally preceded by userinfo and followed by a port.
// Userinfo (`user@host`) is not accepted: such URLs are a phishing vector and stay text.
const HTTP_URL = /^https?:\/\/[^/?#@:]+(?::\d*)?(?:[/?#]|$)/i;

/**
 * Returns the href for a candidate, or undefined when it is not an http(s)
 * URL with a host. The candidate regex already excludes whitespace, control
 * characters and `<>"`, so the matched text is used as-is.
 */
function toHref(candidate: string): string | undefined {
  return HTTP_URL.test(candidate) ? candidate : undefined;
}

/**
 * Splits `text` into text and link segments. Only `http://` and `https://`
 * URLs become links; every other scheme stays text. Concatenating the segment
 * texts always yields the input.
 */
export function linkify(text: string): readonly Segment[] {
  const segments: Segment[] = [];
  let pending = "";
  let cursor = 0;

  const pushText = (s: string): void => {
    pending += s;
  };
  const flush = (): void => {
    if (pending.length > 0) segments.push({ kind: "text", text: pending });
    pending = "";
  };

  for (const match of text.matchAll(CANDIDATE)) {
    const start = match.index;
    const before = start > 0 ? text[start - 1] : undefined;
    if (before !== undefined && /[A-Za-z0-9]/.test(before)) continue;
    const linkText = trimTrailing(match[0]);
    const href = toHref(linkText);
    if (href === undefined) continue;
    pushText(text.slice(cursor, start));
    flush();
    segments.push({ kind: "link", text: linkText, href });
    cursor = start + linkText.length;
  }
  pushText(text.slice(cursor));
  flush();
  return segments;
}
