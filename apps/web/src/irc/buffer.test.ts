import { describe, expect, it } from "vitest";
import { appendLine } from "./buffer.js";
import type { Line } from "./types.js";

const mk = (id: number): Line => ({ id, at: 0, kind: "message", text: `t${id}`, mention: false, own: false });

describe("appendLine", () => {
  it("appends below the cap without mutating the input", () => {
    const input = Object.freeze([mk(1), mk(2)]);
    const out = appendLine(input, mk(3), 5);
    expect(out.map((l) => l.id)).toEqual([1, 2, 3]);
    expect(input).toHaveLength(2);
  });

  it("drops the oldest lines at the cap", () => {
    const out = appendLine([mk(1), mk(2), mk(3)], mk(4), 3);
    expect(out.map((l) => l.id)).toEqual([2, 3, 4]);
  });

  it("defaults to the 1000 line cap", () => {
    let lines: readonly Line[] = [];
    for (let i = 0; i < 1005; i++) lines = appendLine(lines, mk(i));
    expect(lines).toHaveLength(1000);
    expect(lines[0]?.id).toBe(5);
    expect(lines[999]?.id).toBe(1004);
  });

  it("keeps only the new line with cap 1", () => {
    expect(appendLine([mk(1)], mk(2), 1).map((l) => l.id)).toEqual([2]);
  });

  it("rejects an invalid cap", () => {
    expect(() => appendLine([], mk(1), 0)).toThrow(RangeError);
  });
});
