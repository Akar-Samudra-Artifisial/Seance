import { describe, expect, it } from "vitest";
import { formatClock } from "./time.js";

describe("formatClock", () => {
  it("formats UTC midnight", () => {
    expect(formatClock(0, 0)).toBe("00:00");
  });

  it("zero-pads hours and minutes", () => {
    expect(formatClock(Date.UTC(2026, 0, 1, 7, 5), 0)).toBe("07:05");
  });

  it("applies a positive offset and wraps past midnight", () => {
    expect(formatClock(Date.UTC(2026, 0, 1, 23, 30), 90)).toBe("01:00");
  });

  it("applies a negative offset and wraps before midnight", () => {
    expect(formatClock(Date.UTC(2026, 0, 1, 0, 10), -60)).toBe("23:10");
  });

  it("handles timestamps before the epoch", () => {
    expect(formatClock(-60_000, 0)).toBe("23:59");
  });

  it("rejects non-finite input", () => {
    expect(() => formatClock(Number.NaN, 0)).toThrow(RangeError);
  });
});
