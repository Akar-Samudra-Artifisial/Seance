import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { serialize } from "../src/index.js";
import type { IrcMessage } from "../src/index.js";

// Feature: ircd-core, Property P3
// P3 CRLF: every serialized line ends in exactly one "\r\n" and contains no other CR/LF.
// **Validates: Requirements 1.3**

/** Characters of 1 to 4 UTF-8 bytes; never space, CR, LF or NUL. */
const wordCharArb = fc.constantFrom("a", "Z", "7", "#", "!", "@", ".", "-", ":", "é", "日", "👻");

/** Non-empty token without spaces that does not start with ":" (a middle param). */
const middleParamArb = fc
  .array(wordCharArb, { minLength: 1, maxLength: 12 })
  .map((cs) => cs.join(""))
  .filter((s) => !s.startsWith(":"));

/** Any text without CR, LF or NUL; may be empty, contain spaces or start with ":". */
const trailingParamArb = fc
  .array(fc.oneof(wordCharArb, fc.constant(" ")), { maxLength: 60 })
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

describe("P3 CRLF", () => {
  it("serialized lines end in exactly one CRLF and contain no other CR/LF", () => {
    fc.assert(
      fc.property(messageArb, (m) => {
        let line: string;
        try {
          line = serialize(m);
        } catch {
          // Over the 512-byte bound: serialize() throws by design (covered by P2).
          return;
        }
        expect(line.endsWith("\r\n")).toBe(true);
        const body = line.slice(0, -2);
        expect(body).not.toMatch(/[\r\n]/);
        expect((line.match(/\r/g) ?? []).length).toBe(1);
        expect((line.match(/\n/g) ?? []).length).toBe(1);
      }),
      { numRuns: 200 },
    );
  });
});
