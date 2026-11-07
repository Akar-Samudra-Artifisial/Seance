import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { irc_lower } from "./casemap.js";
import { isMention } from "./mention.js";

const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const NICK_REST = LETTERS + "0123456789-[]\\`^{|}_";
// Characters that can never be part of a nick, including multi-byte ones.
const DELIMS = [" ", ",", ":", ".", "!", "?", "(", ")", "@", "#", "\t", "é", "👻"];

const nickArb = fc
  .tuple(
    fc.constantFrom(...LETTERS.split("")),
    fc.array(fc.constantFrom(...NICK_REST.split("")), { maxLength: 8 }),
  )
  .map(([first, rest]) => first + rest.join(""));

const delimArb = fc.constantFrom(...DELIMS);
// Free text over nick characters and delimiters, so near misses are common.
const wordCharArb = fc.constantFrom(...(NICK_REST + DELIMS.join("")).split(""));
const textArb = fc.array(wordCharArb, { maxLength: 30 }).map((cs) => cs.join(""));

/** Randomly flips the case of letters; the rfc1459 pairs [ ] \ map to { } | too. */
function recase(s: string, flips: readonly boolean[]): string {
  const swap: Readonly<Record<string, string>> = { "[": "{", "]": "}", "\\": "|", "{": "[", "}": "]", "|": "\\" };
  return s
    .split("")
    .map((ch, i) => {
      if (!flips[i % Math.max(flips.length, 1)]) return ch;
      return swap[ch] ?? (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase());
    })
    .join("");
}

/** Independent oracle: some maximal run of nick characters equals the nick under case-mapping. */
function oracle(text: string, nick: string): boolean {
  const target = irc_lower(nick);
  return irc_lower(text)
    .split(/[^A-Za-z0-9\-[\]\\`^{|}_]+/)
    .some((run) => run === target);
}

describe("mention properties", () => {
  it(
    "P13 mention detection whole word case mapped",
    () => {
      // **Validates: Requirements 10.1, 10.2**
      const flipsArb = fc.array(fc.boolean(), { minLength: 1, maxLength: 12 });

      // Agrees with the oracle for arbitrary text.
      fc.assert(
        fc.property(textArb, nickArb, (text, nick) => {
          expect(isMention(text, nick)).toBe(oracle(text, nick));
        }),
        { numRuns: 300 },
      );

      // Nick between delimiters or text edges, in any case variant, is a mention.
      fc.assert(
        fc.property(nickArb, flipsArb, delimArb, delimArb, textArb, (nick, flips, d1, d2, filler) => {
          const variant = recase(nick, flips);
          expect(isMention(variant, nick)).toBe(true);
          expect(isMention(`${filler}${d1}${variant}${d2}${filler}`, nick)).toBe(true);
        }),
        { numRuns: 200 },
      );

      // A nick character glued to either side is never a mention.
      fc.assert(
        fc.property(
          nickArb,
          fc.constantFrom(...NICK_REST.split("")),
          fc.boolean(),
          delimArb,
          (nick, glue, left, d) => {
            const glued = left ? `${glue}${nick}` : `${nick}${glue}`;
            expect(isMention(`${d}${glued}${d}`, nick)).toBe(oracle(`${d}${glued}${d}`, nick));
            expect(isMention(glued, nick)).toBe(oracle(glued, nick));
            // The glued word alone is a different word unless the glue itself forms the nick.
            if (irc_lower(glued) !== irc_lower(nick)) expect(isMention(glued, nick)).toBe(false);
          },
        ),
        { numRuns: 200 },
      );
    },
    30_000,
  );
});
