// public-hardening Requirement 6.2: Kiro tokens never reach IRC, not even encoded or in pieces.
import { REDACTED } from "../acp/redact.js";

/** Shortest fragment that is recognised; shorter pieces are the documented residual risk. */
export const MIN_FRAGMENT = 8;
/** Secrets shorter than this are only replaced when they appear whole. */
const MIN_SECRET = MIN_FRAGMENT;
/** Bound on indexed windows (memory); a huge auth dir cannot make the runner slow. */
const MAX_WINDOWS = 2_000_000;

/** Raw, base64 (padded and not), base64url (padded and not) and hex in both cases. */
export function variantsOf(secret: string): readonly string[] {
  const buf = Buffer.from(secret, "utf8");
  const b64 = buf.toString("base64");
  const b64url = buf.toString("base64url");
  const hex = buf.toString("hex");
  const all = [secret, b64, b64.replace(/=+$/, ""), b64url, `${b64url}${"=".repeat((4 - (b64url.length % 4)) % 4)}`, hex, hex.toUpperCase()];
  return [...new Set(all)].filter((v) => v.length > 0);
}

const WHITESPACE = /\s/;

/**
 * Redacts known secrets from agent text. A line loses every whole variant and every run covered by
 * an 8-character window of a variant. Across consecutive texts of one key (a channel), the last
 * 7 non-whitespace characters are kept, so a secret split over two messages is still found: the
 * continuation in the new text is redacted. The first piece (under 8 characters) has already gone
 * out; that is the residual risk documented in docs/SANDBOX.md.
 */
export class SecretRedactor {
  readonly #whole: readonly string[];
  readonly #windows = new Set<string>();
  readonly #tails = new Map<string, string>();

  constructor(secrets: readonly (string | undefined)[]) {
    const known = [...new Set(secrets.filter((s): s is string => s !== undefined && s.length > 0))];
    const whole = new Set<string>();
    for (const secret of known) {
      if (secret.length < MIN_SECRET) {
        whole.add(secret);
        continue;
      }
      for (const v of variantsOf(secret)) {
        whole.add(v);
        for (let i = 0; i + MIN_FRAGMENT <= v.length && this.#windows.size < MAX_WINDOWS; i += 1) {
          this.#windows.add(v.slice(i, i + MIN_FRAGMENT));
        }
      }
    }
    // Longest first, so a variant that contains another is replaced whole.
    this.#whole = [...whole].sort((a, b) => b.length - a.length);
  }

  /** True when there is nothing to redact (no secret configured). */
  get empty(): boolean {
    return this.#whole.length === 0;
  }

  /** Redacts `text`; with `key`, also continuations of a secret split from the previous text of that key. */
  redact(text: string, key?: string): string {
    if (this.empty) return text;
    const marks = new Uint8Array(text.length);
    // 1. whole variants (also short secrets)
    for (const v of this.#whole) {
      let at = text.indexOf(v);
      while (at >= 0) {
        marks.fill(1, at, at + v.length);
        at = text.indexOf(v, at + 1);
      }
    }
    // 2. any fragment of MIN_FRAGMENT or more characters
    for (let i = 0; i + MIN_FRAGMENT <= text.length; i += 1) {
      if (this.#windows.has(text.slice(i, i + MIN_FRAGMENT))) marks.fill(1, i, i + MIN_FRAGMENT);
    }
    // 3. a continuation of the previous text's tail (whitespace between the pieces is ignored)
    const tail = key === undefined ? "" : (this.#tails.get(key) ?? "");
    const positions: number[] = []; // indexes of the first non-whitespace characters of `text`
    for (let i = 0; i < text.length && positions.length < MIN_FRAGMENT - 1; i += 1) {
      if (!WHITESPACE.test(text[i] ?? "")) positions.push(i);
    }
    if (tail !== "") {
      const head = positions.map((i) => text[i] ?? "").join("");
      const joined = tail + head;
      for (let start = 0; start < tail.length; start += 1) {
        const end = start + MIN_FRAGMENT;
        if (end <= tail.length || end > joined.length) continue;
        if (!this.#windows.has(joined.slice(start, end))) continue;
        const lastHead = positions[end - tail.length - 1];
        if (lastHead !== undefined) marks.fill(1, 0, lastHead + 1);
      }
    }
    if (key !== undefined) {
      let stripped = "";
      for (const ch of text) if (!WHITESPACE.test(ch)) stripped += ch;
      this.#tails.set(key, (tail + stripped).slice(-(MIN_FRAGMENT - 1)));
    }
    return apply(text, marks);
  }

  /** Forgets the tail of `key` (a turn ended); later texts are checked on their own again. */
  endTurn(key: string): void {
    this.#tails.delete(key);
  }
}

function apply(text: string, marks: Uint8Array): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (marks[i] === 1) {
      while (i < text.length && marks[i] === 1) i += 1;
      out += REDACTED;
    } else {
      out += text[i] ?? "";
      i += 1;
    }
  }
  return out;
}
