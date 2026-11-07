import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatIrc } from "./formatter.js";

// Mix of ASCII control chars (including IRC formatting codes), digits, commas and printable text,
// so color sequences like "\x03" + "12,4" are common.
const CONTROL_CHARS = Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(i)).concat("\x7f");
const charArb = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(...CONTROL_CHARS) },
  { weight: 3, arbitrary: fc.constantFrom("0", "1", "5", "9", ",", "15", "16", "99") },
  { weight: 3, arbitrary: fc.string({ unit: "grapheme", maxLength: 3 }) },
);
const textArb = fc.array(charArb, { maxLength: 40 }).map((parts) => parts.join(""));

const isColor = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= 15;

describe("formatIrc controls", () => {
  // **Validates: Requirements 8.1, 8.4, 8.6, 17.4**
  it("P5 formatter emits no control codes", { timeout: 30_000 }, () => {
    fc.assert(
      fc.property(textArb, (input) => {
        for (const span of formatIrc(input)) {
          for (const ch of span.text) {
            const code = ch.codePointAt(0) ?? 0;
            expect(code < 0x20 || code === 0x7f).toBe(false);
          }
          if (span.fg !== undefined) expect(isColor(span.fg)).toBe(true);
          if (span.bg !== undefined) expect(isColor(span.bg)).toBe(true);
        }
      }),
      { numRuns: 200 },
    );
  });
});
