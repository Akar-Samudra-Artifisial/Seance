import * as fc from "fast-check";

/** Text mixing ASCII, accented, CJK, emoji and combining characters (multi-byte UTF-8). */
export const multiByteText: fc.Arbitrary<string> = fc
  .array(
    fc.oneof(
      fc.string({ unit: "grapheme-ascii", maxLength: 8 }),
      fc.constantFrom("é", "ü", "ñ", "日本語", "한국어", "🙂", "👻", "🧙‍♂️", "e\u0301", "Ω", "ß"),
    ),
    { maxLength: 40 },
  )
  .map((parts) => parts.join(""));

const NICK_FIRST = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const NICK_REST = [...NICK_FIRST, ..."0123456789-[]\\`^{}_".split("")];

/** Nicks accepted by `isValidNick`: 1-30 chars, letter first. */
export const validNick: fc.Arbitrary<string> = fc
  .tuple(fc.constantFrom(...NICK_FIRST), fc.array(fc.constantFrom(...NICK_REST), { maxLength: 29 }))
  .map(([first, rest]) => first + rest.join(""));

const CHANNEL_CHARS = [..."abcdefghijklmnopqrstuvwxyz0123456789-_.".split(""), "é", "日"];

/** Channel names accepted by `isValidChannel`: `#` plus 1-49 safe characters. */
export const channelName: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...CHANNEL_CHARS), { minLength: 1, maxLength: 20 })
  .map((chars) => `#${chars.join("")}`);

/** Text dense with tag-like and marker fragments, for untrusted-wrapping tests. */
export const tagHeavyText: fc.Arbitrary<string> = fc
  .array(
    fc.oneof(
      fc.constantFrom(
        "<untrusted>",
        "</untrusted>",
        "</UNTRUSTED>",
        "< /untrusted >",
        "<untrusted ",
        "<",
        ">",
        "&lt;",
        "\n",
        " ",
      ),
      fc.string({ unit: "grapheme-ascii", maxLength: 6 }),
      multiByteText,
    ),
    { maxLength: 30 },
  )
  .map((parts) => parts.join(""));

export interface MeteringEntryFixture {
  readonly value: unknown;
  readonly unit: unknown;
}

/** Metering entries: credit and other units; finite, negative, NaN, Infinity, non-numbers. */
export const meteringEntry: fc.Arbitrary<MeteringEntryFixture> = fc.record({
  value: fc.oneof(
    fc.double({ noNaN: true, noDefaultInfinity: true, min: 0, max: 1000 }),
    fc.double({ noNaN: true, noDefaultInfinity: true, min: -1000, max: -Number.MIN_VALUE }),
    fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
    fc.string({ maxLength: 5 }),
    fc.constantFrom(null, undefined),
  ),
  unit: fc.oneof(fc.constant("credit"), fc.constant("credit"), fc.string({ maxLength: 8 }), fc.constantFrom(null, 1)),
});

export const meteringEntries: fc.Arbitrary<readonly MeteringEntryFixture[]> = fc.array(meteringEntry, { maxLength: 10 });
