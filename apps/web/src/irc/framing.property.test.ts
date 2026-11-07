import { LineFramer } from "@seance/irc-protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decodeFrames, type DecodedFrame } from "./framing.js";

// Characters of 1 to 4 UTF-8 bytes; no CR, LF or NUL.
const char = fc.constantFrom("a", "Z", "7", " ", ":", "#", "é", "ß", "漢", "字", "👻", "🎃", "\u{1F47B}");

// Non-empty (the framer skips empty lines); up to 60 chars of at most 4 bytes
// each stays well under the 512-byte limit.
const line = fc.array(char, { minLength: 1, maxLength: 60 }).map((cs) => cs.join(""));

const terminator = fc.constantFrom("\r\n", "\n");

/**
 * Splits `text` at the given cut points (any order, duplicates allowed).
 * Cuts fall on code point boundaries: WebSocket text frames are valid Unicode
 * and never contain half a surrogate pair.
 */
function partition(text: string, cuts: readonly number[]): readonly string[] {
  const points = Array.from(text);
  const at = [...new Set(cuts.map((c) => c % (points.length + 1)))].sort((a, b) => a - b);
  const frames: string[] = [];
  let prev = 0;
  for (const p of at) {
    frames.push(points.slice(prev, p).join(""));
    prev = p;
  }
  frames.push(points.slice(prev).join(""));
  return frames;
}

describe("framing properties", () => {
  it(
    "P11 framing independent of chunking",
    () => {
      // **Validates: Requirements 2.5**
      fc.assert(
        fc.property(
          fc.array(fc.tuple(line, terminator), { minLength: 0, maxLength: 12 }),
          fc.array(fc.nat(), { minLength: 0, maxLength: 20 }),
          (entries, cuts) => {
            const text = entries.map(([l, t]) => l + t).join("");

            const whole = decodeFrames(new LineFramer(), text);

            const framer = new LineFramer();
            const chunked: DecodedFrame[] = [];
            for (const frame of partition(text, cuts)) {
              chunked.push(...decodeFrames(framer, frame));
            }

            expect(chunked).toEqual(whole);
            expect(whole).toEqual(entries.map(([l]) => ({ kind: "line", line: l })));
          },
        ),
        { numRuns: 200 },
      );
    },
    20_000,
  );
});
