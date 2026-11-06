import fc from "fast-check";
import { describe, it } from "vitest";
import { irc_lower } from "../src/index.js";

// Feature: ircd-core, Property P5
// Case-mapping: irc_lower is idempotent, and irc_lower(a) == irc_lower(b)
// iff a and b collide under rfc1459 case-mapping.
// **Validates: Requirements 3.3**

/** Independent oracle: the rfc1459 equivalence class representative of a char. */
const RFC1459_UPPER: Readonly<Record<string, string>> = {
  "[": "{",
  "]": "}",
  "\\": "|",
  "~": "^",
};

function collides(a: string, b: string): boolean {
  const ca = [...a];
  const cb = [...b];
  if (ca.length !== cb.length) return false;
  return ca.every((x, i) => {
    const y = cb[i] ?? "";
    return canonical(x) === canonical(y);
  });
}

function canonical(ch: string): string {
  const mapped = RFC1459_UPPER[ch];
  if (mapped !== undefined) return mapped;
  return /^[A-Z]$/.test(ch) ? ch.toLowerCase() : ch;
}

// Small alphabet containing both members of each folding pair, so that
// collisions between distinct strings occur frequently.
const nickChar = fc.constantFrom(..."aAbB{[}]|\\^~_-`0".split(""));
const nickLike = fc.array(nickChar, { maxLength: 12 }).map((cs) => cs.join(""));
const anyString = fc.oneof(nickLike, fc.string({ unit: "grapheme", maxLength: 20 }));

describe("P5 case-mapping", () => {
  it("irc_lower is idempotent", () => {
    fc.assert(
      fc.property(anyString, (s) => irc_lower(irc_lower(s)) === irc_lower(s)),
      { numRuns: 200 },
    );
  });

  it("irc_lower(a) == irc_lower(b) iff a and b collide under rfc1459", () => {
    fc.assert(
      fc.property(nickLike, nickLike, (a, b) => (irc_lower(a) === irc_lower(b)) === collides(a, b)),
      { numRuns: 500 },
    );
  });

  it("a string always collides with its own case-swapped variant", () => {
    const swap = (s: string): string =>
      [...s]
        .map((ch) => {
          if (/^[a-z]$/.test(ch)) return ch.toUpperCase();
          if (/^[A-Z]$/.test(ch)) return ch.toLowerCase();
          const pairs: Readonly<Record<string, string>> = {
            "{": "[",
            "}": "]",
            "|": "\\",
            "^": "~",
            "[": "{",
            "]": "}",
            "\\": "|",
            "~": "^",
          };
          return pairs[ch] ?? ch;
        })
        .join("");
    fc.assert(
      fc.property(nickLike, (s) => irc_lower(s) === irc_lower(swap(s))),
      { numRuns: 200 },
    );
  });
});
