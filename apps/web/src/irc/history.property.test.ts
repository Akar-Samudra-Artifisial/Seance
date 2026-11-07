import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EMPTY_HISTORY, navigate, pushHistory, type History, type HistoryDirection } from "./history.js";
import { HISTORY_MAX } from "./types.js";

type Op =
  | { readonly kind: "push"; readonly text: string }
  | { readonly kind: "move"; readonly direction: HistoryDirection; readonly current: string };

const text = fc.string({ maxLength: 12, unit: "binary" });

const opArb: fc.Arbitrary<Op> = fc.oneof(
  text.map((t): Op => ({ kind: "push", text: t })),
  fc.record({
    kind: fc.constant("move" as const),
    direction: fc.constantFrom<HistoryDirection>("up", "down"),
    current: text,
  }),
);

function inRange(h: History): boolean {
  return Number.isInteger(h.position) && h.position >= 0 && h.position <= h.entries.length;
}

describe("history properties", () => {
  // Feature: web-client-basic, Property 20: Command history is bounded
  // **Validates: Requirements 7.23**
  it("P20 command history is bounded", { timeout: 60_000 }, () => {
    fc.assert(
      fc.property(
        fc.array(opArb, { maxLength: 400 }),
        fc.array(text, { minLength: HISTORY_MAX + 1, maxLength: HISTORY_MAX * 2 }),
        (ops, many) => {
          // Arbitrary push/move sequences stay bounded with a valid position.
          let h = EMPTY_HISTORY;
          for (const op of ops) {
            if (op.kind === "push") {
              h = pushHistory(h, op.text);
              expect(h.position).toBe(h.entries.length);
            } else {
              h = navigate(h, op.direction, op.current).history;
            }
            expect(h.entries.length).toBeLessThanOrEqual(HISTORY_MAX);
            expect(inRange(h)).toBe(true);
          }

          // Overflowing pushes keep the newest entries; Up returns the latest one.
          let full = EMPTY_HISTORY;
          const accepted: string[] = [];
          for (const entry of many) {
            full = pushHistory(full, entry);
            if (entry !== "" && entry !== accepted[accepted.length - 1]) accepted.push(entry);
            expect(full.entries.length).toBeLessThanOrEqual(HISTORY_MAX);
          }
          expect(full.entries).toEqual(accepted.slice(-HISTORY_MAX));
          if (accepted.length > 0) {
            const up = navigate(full, "up", "draft");
            expect(up.text).toBe(accepted[accepted.length - 1]);
            expect(inRange(up.history)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
