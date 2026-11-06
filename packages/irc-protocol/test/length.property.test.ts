import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { serialize } from "../src/index.js";
import type { IrcMessage } from "../src/index.js";

// Feature: ircd-core, Property P2
// P2 length bound: serialize(m) is at most 512 UTF-8 bytes including CRLF, or throws.
// **Validates: Requirements 1.3**

const MAX_LINE_BYTES = 512;

/** Characters of 1 to 4 UTF-8 bytes; never space, CR, LF or NUL. */
const wordCharArb = fc.constantFrom("a", "Z", "7", "#", "!", "@", ".", "-", ":", "é", "日", "👻");

/** Non-empty token without spaces that does not start with ":" (a middle param). */
const middleParamArb = fc
  .array(wordCharArb, { minLength: 1, maxLength: 40 })
  .map((cs) => cs.join(""))
  .filter((s) => !s.startsWith(":"));

/** Any text without CR, LF or NUL; may be empty, contain spaces or start with ":". */
const trailingParamArb = fc
  .array(fc.oneof(wordCharArb, fc.constant(" ")), { maxLength: 200 })
  .map((cs) => cs.join(""));

/** Upper-case command: letters, or exactly three digits. */
const commandArb = fc.oneof(
  fc.stringMatching(/^[A-Z]{1,12}$/),
  fc.stringMatching(/^[0-9]{3}$/),
);

const prefixArb = fc
  .array(wordCharArb, { minLength: 1, maxLength: 60 })
  .map((cs) => cs.join(""));

/** Valid messages sized so that roughly half stay under and half cross 512 bytes. */
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

/** Valid messages with many long params, which usually exceed 512 bytes. */
const largeMessageArb: fc.Arbitrary<IrcMessage> = fc
  .record({
    command: commandArb,
    middle: fc.array(
      fc
        .array(wordCharArb, { minLength: 20, maxLength: 40 })
        .map((cs) => cs.join(""))
        .filter((s) => !s.startsWith(":")),
      { minLength: 8, maxLength: 14 },
    ),
    last: fc
      .array(fc.oneof(wordCharArb, fc.constant(" ")), { minLength: 150, maxLength: 250 })
      .map((cs) => cs.join("")),
  })
  .map(({ command, middle, last }) => ({ command, params: [...middle, last] }));

const anyMessageArb: fc.Arbitrary<IrcMessage> = fc.oneof(messageArb, largeMessageArb);

/** Serialize, returning the line or the thrown Error. */
function attempt(m: IrcMessage): string | Error {
  try {
    return serialize(m);
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

describe("P2 length bound", () => {
  it("P2 length bound", () => {
    fc.assert(
      fc.property(anyMessageArb, (m) => {
        const result = attempt(m);
        if (typeof result === "string") {
          expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(MAX_LINE_BYTES);
          expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(MAX_LINE_BYTES);
        } else {
          // A valid message may only be rejected because of its length.
          expect(result.message).toContain(`exceeds the ${MAX_LINE_BYTES}-byte limit`);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("generator crosses the 512-byte boundary in both directions", () => {
    const results = fc.sample(anyMessageArb, { numRuns: 300, seed: 1 }).map(attempt);
    expect(results.some((r) => typeof r === "string")).toBe(true);
    expect(results.some((r) => r instanceof Error)).toBe(true);
  });
});
