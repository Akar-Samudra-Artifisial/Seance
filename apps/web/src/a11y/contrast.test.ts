import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Validates: Requirements 14.1, 14.3, 14.9

const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");

function parseTokens(source: string): ReadonlyMap<string, string> {
  const tokens = new Map<string, string>();
  for (const m of source.matchAll(/--color-([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    const name = m[1];
    const hex = m[2];
    if (name !== undefined && hex !== undefined) tokens.set(name, hex);
  }
  return tokens;
}

const tokens = parseTokens(css);

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function tok(name: string): string {
  const v = tokens.get(name);
  if (v === undefined) throw new Error(`token --color-${name} not found in app/globals.css`);
  return v;
}

const BODY = 4.5;
const LARGE_OR_UI = 3;

// [foreground, background, minimum ratio, where it is used]
const PAIRS: readonly (readonly [string, string, number, string])[] = [
  // Ghost surfaces: chat text and accents.
  ["ghost-text", "ghost-bg", BODY, "chat text"],
  ["ghost-orange", "ghost-bg", BODY, "mentions, human nicks, kick lines"],
  ["ghost-green", "ghost-bg", BODY, "joins, whois heading"],
  ["ghost-purple", "ghost-bg", BODY, "system lines, researcher"],
  ["nick-coder", "ghost-bg", BODY, "coder nick"],
  ["nick-reviewer", "ghost-bg", BODY, "reviewer nick"],
  ["nick-researcher", "ghost-bg", BODY, "researcher nick"],
  ["nick-human", "ghost-bg", BODY, "human nick"],
  ["ghost-orange", "ghost-bg", LARGE_OR_UI, "focus ring on ghost surfaces"],
  // Chrome surfaces.
  ["chrome-outline", "chrome-face", BODY, "chrome text"],
  ["chrome-outline", "chrome-face", LARGE_OR_UI, "focus ring and bevel on chrome"],
  ["irc-5", "chrome-face", BODY, "inline error text in ConnectDialog"],
  ["chrome-highlight", "title-from", BODY, "title text, left end of gradient"],
  ["chrome-highlight", "title-from", LARGE_OR_UI, "menu hover"],
  // Title text is VT323 20px bold (large text), so 3:1 applies at the lighter gradient end.
  ["chrome-highlight", "title-to", LARGE_OR_UI, "title text, right end of gradient (large bold)"],
  ["chrome-highlight", "title-to", LARGE_OR_UI, "focus ring of the title-bar close button"],
];

describe("WCAG contrast of documented token pairs", () => {
  it("parses the documented tokens", () => {
    expect(tokens.get("ghost-bg")).toBe("#0b0b0f");
    expect(tokens.get("chrome-face")).toBe("#c0c0c0");
  });

  it.each(PAIRS)("%s on %s reaches %f:1 (%s)", (fg, bg, min) => {
    expect(contrast(tok(fg), tok(bg))).toBeGreaterThanOrEqual(min);
  });

  it("flags irc-4 red on the chrome face as non-compliant (why errors use irc-5)", () => {
    expect(contrast(tok("irc-4"), tok("chrome-face"))).toBeLessThan(BODY);
  });
});
