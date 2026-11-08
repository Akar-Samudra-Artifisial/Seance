// Feature: web-client-pixel-match, Property 7: Layout sum
// **Validates: Requirements 1.1, 1.8**
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { LAYOUT, totalHeight } from "./metrics.js";

const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
const cssPx = (name: string): number | undefined => {
  const m = new RegExp(`--layout-${name}:\\s*(\\d+)px;`).exec(css);
  return m === null ? undefined : Number(m[1]);
};

const kebab = (s: string): string => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

describe("P7 layout sum", () => {
  it("P7 rows sum to 900 with the tray and 870 without it", () => {
    expect(totalHeight(true)).toBe(900);
    expect(totalHeight(false)).toBe(870);
    fc.assert(
      fc.property(fc.boolean(), (tray) => {
        expect(totalHeight(tray)).toBe(tray ? 900 : 870);
        expect(totalHeight(true) - totalHeight(false)).toBe(LAYOUT.tray + LAYOUT.gap);
      }),
      { numRuns: 100 },
    );
  });

  it("P7 the CSS tokens equal the TypeScript metrics", () => {
    for (const [key, value] of Object.entries(LAYOUT)) {
      if (typeof value === "number") expect(cssPx(kebab(key)), key).toBe(value);
    }
    expect(cssPx("nick-desktop")).toBe(LAYOUT.nickList.desktop);
    expect(cssPx("nick-medium")).toBe(LAYOUT.nickList.medium);
    expect(cssPx("nick-overlay")).toBe(LAYOUT.nickList.overlay);
  });

  it("chat pane and nick list span the frame width at 1440 (3 + 1250 + 3 + 181 + 3)", () => {
    expect(LAYOUT.frame + LAYOUT.chatWidth + 3 + LAYOUT.nickList.desktop + LAYOUT.frame).toBe(1440);
  });
});
