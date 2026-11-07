import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CreditAccumulator } from "../src/credits/accumulator.js";

/**
 * P6: session credits never decrease and equal the sum of accepted metering values.
 * **Validates: Requirements 10.15, 10.1, 10.2**
 */
const TAG =
  "Feature: agent-runner, Property 6: session credits never decrease and equal the sum of accepted metering values";
const RUNS = { numRuns: 200 } as const;

/** Multiples of 1/64 so floating-point addition is exact. */
const dyadicArb = fc.integer({ min: 0, max: 6400 }).map((n) => n / 64);
const negativeArb = fc.integer({ min: 1, max: 6400 }).map((n) => -n / 64);

const valueArb = fc.oneof(
  dyadicArb,
  negativeArb,
  fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
  fc.string({ unit: "binary" }),
  fc.constantFrom("日本語", "😀", "é", "1"),
  fc.constant(null),
);

const unitArb = fc.oneof(fc.constant("credit"), fc.string(), fc.constantFrom("Credit", "日本", "😀"));

const entryArb: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ unit: unitArb, value: valueArb }) },
  // Missing fields and non-object entries.
  { weight: 1, arbitrary: fc.record({ unit: unitArb }) },
  { weight: 1, arbitrary: fc.record({ value: valueArb }) },
  { weight: 1, arbitrary: fc.constantFrom({}, null, 7, "credit", []) },
);

const isAccepted = (entry: unknown): entry is { unit: "credit"; value: number } => {
  if (typeof entry !== "object" || entry === null) return false;
  const r = entry as Record<string, unknown>;
  return (
    r["unit"] === "credit" && typeof r["value"] === "number" && Number.isFinite(r["value"]) && r["value"] >= 0
  );
};

describe("P6 credit accumulation", () => {
  it(TAG, () => {
    fc.assert(
      fc.property(fc.array(fc.array(entryArb, { maxLength: 5 }), { maxLength: 40 }), (messages) => {
        const acc = new CreditAccumulator("test-session");
        let oracle = 0;
        let previous = 0;
        for (const entries of messages) {
          const result = acc.add(entries);
          expect(acc.total).toBeGreaterThanOrEqual(previous);
          previous = acc.total;
          for (const e of entries) if (isAccepted(e)) oracle += e.value;
          const rejectedCount = entries.filter((e) => !isAccepted(e)).length;
          expect(result.rejected).toHaveLength(rejectedCount);
          expect(new Set(result.rejected.map((r) => r.index)).size).toBe(rejectedCount);
        }
        expect(acc.total).toBe(oracle);
      }),
      RUNS,
    );
  });
});
