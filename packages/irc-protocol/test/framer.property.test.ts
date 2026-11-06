import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { LineFramer } from "../src/index.js";
import type { FramerEvent } from "../src/index.js";

// Feature: ircd-core, Property P4
// P4 framing independence: splitting a byte stream into arbitrary chunks
// yields the same lines from LineFramer.
// **Validates: Requirements 1.1, 2.2**

const encoder = new TextEncoder();

/** Characters of 1, 2, 3 and 4 UTF-8 bytes; never CR, LF or NUL. */
const charArb = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom("a", "Z", "7", " ", ":", "#", "!", "~") },
  { weight: 1, arbitrary: fc.constantFrom("é", "ñ", "日", "本", "€", "👻", "🎃") },
);

/** Non-empty line body of at most 100 characters (≤ 400 bytes, under the limit). */
const lineArb = fc.array(charArb, { minLength: 1, maxLength: 100 }).map((cs) => cs.join(""));

const terminatorArb = fc.constantFrom("\r\n", "\n");

const streamArb = fc.array(fc.tuple(lineArb, terminatorArb), { minLength: 0, maxLength: 20 });

/** Cut a byte array at the given (unsorted, possibly duplicate) offsets. */
const split = (bytes: Uint8Array, cuts: readonly number[]): readonly Uint8Array[] => {
  const points = [...new Set(cuts.map((c) => c % (bytes.length + 1)))].sort((a, b) => a - b);
  const chunks: Uint8Array[] = [];
  let prev = 0;
  for (const p of points) {
    chunks.push(bytes.subarray(prev, p));
    prev = p;
  }
  chunks.push(bytes.subarray(prev));
  return chunks;
};

const feed = (chunks: readonly Uint8Array[]): readonly FramerEvent[] => {
  const framer = new LineFramer();
  return chunks.flatMap((c) => framer.push(c));
};

describe("LineFramer properties", () => {
  it("P4 framing independence: any chunking yields the same lines", () => {
    fc.assert(
      fc.property(streamArb, fc.array(fc.nat(), { maxLength: 40 }), (parts, cuts) => {
        const bytes = encoder.encode(parts.map(([body, term]) => body + term).join(""));
        const expected = parts.map(([body]) => ({ kind: "line", line: body }));

        const whole = feed([bytes]);
        const chunked = feed(split(bytes, cuts));
        const bytewise = feed(Array.from(bytes, (b) => Uint8Array.of(b)));

        expect(whole).toEqual(expected);
        expect(chunked).toEqual(whole);
        expect(bytewise).toEqual(whole);
      }),
      { numRuns: 200 },
    );
  });

  it("P4 framing independence: string and byte chunks agree", () => {
    fc.assert(
      fc.property(streamArb, (parts) => {
        const text = parts.map(([body, term]) => body + term).join("");
        const asString = new LineFramer().push(text);
        const asBytes = new LineFramer().push(encoder.encode(text));
        expect(asString).toEqual(asBytes);
      }),
      { numRuns: 100 },
    );
  });
});
