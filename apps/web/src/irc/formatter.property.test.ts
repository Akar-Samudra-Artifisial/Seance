import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatIrc } from "./formatter.js";

/**
 * Independent oracle: strip colour sequences with a regex, then remove the
 * remaining control characters, and turn tab into a space.
 */
function oracle(input: string): string {
  return input
    .replace(/\x03(?:[0-9]{1,2}(?:,[0-9]{1,2})?)?/g, "")
    .replace(/\t/g, " ")
    .replace(/[\x00-\x08\x0a-\x1f\x7f]/g, "");
}

const controlish = fc.constantFrom(
  "\x02",
  "\x03",
  "\x0f",
  "\x1f",
  "\t",
  "\x00",
  "\x07",
  "\x7f",
  ",",
  "0",
  "5",
  "9",
  "15",
  "99",
);

const mixed = fc
  .array(fc.oneof(controlish, controlish, fc.string({ unit: "grapheme", maxLength: 6 })), {
    maxLength: 40,
  })
  .map((parts) => parts.join(""));

describe("formatIrc properties", () => {
  it("P4 formatter preserves visible characters", { timeout: 30_000 }, () => {
    // **Validates: Requirements 8.4, 8.5, 17.4**
    fc.assert(
      fc.property(mixed, (input) => {
        const joined = formatIrc(input)
          .map((s) => s.text)
          .join("");
        expect(joined).toBe(oracle(input));
      }),
      { numRuns: 500 },
    );
  });
});
