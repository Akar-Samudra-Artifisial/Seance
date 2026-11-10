// Feature: web-client-pixel-match, Property 6: Menu fit
// **Validates: Requirements 11.4**
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fitCount } from "./fit.js";
import { MENU_SLOTS } from "./metrics.js";

const widths = fc.array(fc.integer({ min: 1, max: 120 }), { minLength: 1, maxLength: 9 });
const width = fc.integer({ min: 0, max: 1500 });
const reserve = fc.integer({ min: 0, max: 120 });
const overflow = fc.integer({ min: 0, max: 40 });
const sum = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

describe("P6 menu fit", () => {
  it("P6 the first k items fit and item k+1 would not (or k is all)", () => {
    fc.assert(
      fc.property(width, widths, reserve, overflow, (w, items, r, o) => {
        const k = fitCount(w, items, r, o);
        expect(k).toBeGreaterThanOrEqual(0);
        expect(k).toBeLessThanOrEqual(items.length);
        if (k === items.length) {
          expect(sum(items) + r <= w || sum(items) + r + o <= w).toBe(true);
          return;
        }
        // Shown items plus the overflow button fit; one more would not.
        expect(sum(items.slice(0, k)) + r + o).toBeLessThanOrEqual(Math.max(w, r + o));
        expect(sum(items.slice(0, k + 1)) + r + o).toBeGreaterThan(w);
      }),
      { numRuns: 300 },
    );
  });

  it("P6 shown plus overflow is the whole list in order, and k grows with the width", () => {
    fc.assert(
      fc.property(width, fc.integer({ min: 0, max: 300 }), widths, reserve, overflow, (w, extra, items, r, o) => {
        const k = fitCount(w, items, r, o);
        const shown = items.slice(0, k);
        const hidden = items.slice(k);
        expect([...shown, ...hidden]).toEqual(items);
        expect(fitCount(w + extra, items, r, o)).toBeGreaterThanOrEqual(k);
      }),
      { numRuns: 300 },
    );
  });

  it("shows all six menus at 1440 and fewer at 360", () => {
    const menus = [...MENU_SLOTS];
    expect(menus).toHaveLength(6);
    expect(fitCount(1434, menus, 20 + 54, 24)).toBe(6);
    expect(fitCount(354, menus, 20 + 54, 24)).toBeLessThan(6);
  });
});
