// Feature: web-client-pixel-match, Property 2: Readable colours
// **Validates: Requirements 10.1, 10.2, 10.3, 10.4**
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  GHOST_BG,
  IRC_FG,
  IRC_PALETTE,
  READABLE_CLASSES,
  READABLE_RATIO,
  colourOfClass,
  contrast,
  readableClass,
} from "./colors.js";

const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
const token = (name: string): string | undefined =>
  new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(css)?.[1]?.toLowerCase();

const index = fc.integer({ min: 0, max: 15 });

describe("P2 readable colours", () => {
  it("P2 every IRC foreground without a background meets 4.5:1 on the ghost background", () => {
    fc.assert(
      fc.property(index, (fg) => {
        const cls = readableClass(fg, undefined);
        expect(READABLE_CLASSES).toContain(cls);
        const hex = colourOfClass(cls);
        expect(hex).toBeDefined();
        expect(contrast(hex ?? "#000000", GHOST_BG)).toBeGreaterThanOrEqual(READABLE_RATIO);
      }),
      { numRuns: 100 },
    );
  });

  it("P2 every colour pair renders with a foreground that meets 4.5:1 on its background", () => {
    fc.assert(
      fc.property(index, index, (fg, bg) => {
        const cls = readableClass(fg, bg);
        expect(READABLE_CLASSES).toContain(cls);
        const hex = colourOfClass(cls);
        const bgHex = IRC_PALETTE[bg];
        expect(hex).toBeDefined();
        expect(contrast(hex ?? "#000000", bgHex ?? "#000000")).toBeGreaterThanOrEqual(READABLE_RATIO);
      }),
      { numRuns: 300 },
    );
  });

  it("checks all 16 foregrounds and all 256 pairs exhaustively", () => {
    for (let fg = 0; fg < 16; fg += 1) {
      expect(contrast(colourOfClass(readableClass(fg, undefined)) ?? "", GHOST_BG)).toBeGreaterThanOrEqual(4.5);
      for (let bg = 0; bg < 16; bg += 1) {
        const hex = colourOfClass(readableClass(fg, bg)) ?? "";
        expect(contrast(hex, IRC_PALETTE[bg] ?? "")).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps a pair that is already readable unchanged", () => {
    // White on black and black on white are 21:1.
    expect(readableClass(0, 1)).toBe("text-irc-0");
    expect(readableClass(1, 0)).toBe("text-irc-1");
  });

  it("makes the agent reply colour \\x0312 readable (R10.3)", () => {
    expect(contrast(IRC_FG[12], GHOST_BG)).toBeGreaterThanOrEqual(4.5);
    expect(readableClass(12, undefined)).toBe("text-irc-fg-12");
  });

  it("mirrors app/globals.css exactly", () => {
    IRC_PALETTE.forEach((hex, i) => {
      expect(token(`irc-${i}`)).toBe(hex);
    });
    IRC_FG.forEach((hex, i) => {
      expect(token(`irc-fg-${i}`)).toBe(hex);
    });
    expect(token("ghost-bg")).toBe(GHOST_BG);
    expect(token("chrome-highlight")).toBe("#ffffff");
    expect(token("chrome-outline")).toBe("#000000");
  });
});
