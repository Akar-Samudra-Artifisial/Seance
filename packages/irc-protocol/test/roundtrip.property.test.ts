import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isParseError, parse, serialize } from "../src/index.js";
import type { IrcMessage } from "../src/index.js";

// Feature: ircd-core, Property P1
// P1 round-trip: parse(serialize(m)) deep-equals m for every valid IrcMessage.
// **Validates: Requirements 1.1**

/** Characters of 1 to 4 UTF-8 bytes; never space, CR, LF or NUL. */
const wordCharArb = fc.constantFrom("a", "Z", "7", "#", "!", "@", ".", "-", ":", "é", "日", "👻");

/** Non-empty token without spaces that does not start with ":" (a middle param). */
const middleParamArb = fc
  .array(wordCharArb, { minLength: 1, maxLength: 12 })
  .map((cs) => cs.join(""))
  .filter((s) => !s.startsWith(":"));

/** Any text without CR, LF or NUL; may be empty, contain spaces or start with ":". */
const trailingParamArb = fc
  .array(fc.oneof(wordCharArb, fc.constant(" ")), { maxLength: 30 })
  .map((cs) => cs.join(""));

/** Upper-case command: letters, or exactly three digits. */
const commandArb = fc.oneof(
  fc.stringMatching(/^[A-Z]{1,12}$/),
  fc.stringMatching(/^[0-9]{3}$/),
);

const prefixArb = fc
  .array(wordCharArb, { minLength: 1, maxLength: 30 })
  .map((cs) => cs.join(""));

const messageArb: fc.Arbitrary<IrcMessage> = fc
  .record({
    prefix: fc.option(prefixArb, { nil: undefined }),
    command: commandArb,
    middle: fc.array(middleParamArb, { maxLength: 14 }),
    last: fc.option(trailingParamArb, { nil: undefined }),
  })
  .map(({ prefix, command, middle, last }) => {
    const params = last === undefined ? middle : [...middle, last];
    return prefix === undefined ? { command, params } : { prefix, command, params };
  });

describe("P1 round-trip", () => {
  it("parse(serialize(m)) deep-equals m", () => {
    fc.assert(
      fc.property(messageArb, (m) => {
        const parsed = parse(serialize(m));
        expect(isParseError(parsed)).toBe(false);
        expect(parsed).toEqual(m);
      }),
      { numRuns: 200 },
    );
  });
});
