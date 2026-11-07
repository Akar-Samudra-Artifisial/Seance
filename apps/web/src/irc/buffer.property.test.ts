import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { appendLine } from "./buffer.js";
import type { Line } from "./types.js";

const mk = (id: number): Line => ({ id, at: 0, kind: "message", text: `t${id}`, mention: false, own: false });

describe("buffer properties", () => {
  it("P12 buffers stay capped and keep newest lines", () => {
    // **Validates: Requirements 5.13, 15.5**
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), fc.integer({ min: 0, max: 200 }), (cap, n) => {
        let lines: readonly Line[] = [];
        const all: Line[] = [];
        for (let i = 0; i < n; i++) {
          const line = mk(i);
          all.push(line);
          lines = appendLine(lines, line, cap);
          expect(lines.length).toBeLessThanOrEqual(cap);
        }
        expect(lines.map((l) => l.id)).toEqual(all.slice(-Math.min(n, cap)).map((l) => l.id));
        if (n === 0) expect(lines).toHaveLength(0);
      }),
      { numRuns: 100 },
    );
  });
});
