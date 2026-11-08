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

// The Classic block overrides tokens under html[data-theme="classic"]; read it apart from the Ghost set.
const CLASSIC_MARKER = "html[data-theme=\"classic\"]";
const classicAt = css.indexOf(CLASSIC_MARKER);
const tokens = parseTokens(classicAt === -1 ? css : css.slice(0, classicAt));
/** Ghost tokens with the Classic overrides applied: what the page uses under data-theme=classic. */
const classicTokens: ReadonlyMap<string, string> = new Map([
  ...tokens,
  ...(classicAt === -1 ? [] : parseTokens(css.slice(classicAt))),
]);

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
  // Chat line colours (R16.2, R16.3).
  ["link-blue", "ghost-bg", BODY, "links in chat"],
  ["timestamp-dim", "ghost-bg", BODY, "timestamps"],
  ["action-purple", "ghost-bg", BODY, "action lines"],
  ["event-green", "ghost-bg", BODY, "event lines"],
  ["tool-grey", "ghost-bg", BODY, "tool notices"],
  ["away-grey", "ghost-bg", BODY, "away nicks and lines"],
  ["mention-bar", "ghost-bg", LARGE_OR_UI, "mention bar (non-text)"],
  // Inactive title bar and switchbar.
  ["title-inactive-text", "title-inactive-from", BODY, "inactive title text, left end"],
  ["title-inactive-text", "title-inactive-to", BODY, "inactive title text, right end"],
  ["switch-text", "switch-face", BODY, "switchbar button"],
  ["switch-text", "switch-active", BODY, "active switchbar button"],
  // Chrome surfaces.
  ["chrome-outline", "chrome-face", BODY, "chrome text"],
  ["chrome-outline", "chrome-face", LARGE_OR_UI, "focus ring and bevel on chrome"],
  ["irc-5", "chrome-face", BODY, "inline error text in ConnectDialog"],
  ["chrome-highlight", "title-from", BODY, "title text, left end of gradient"],
  ["chrome-highlight", "title-from", LARGE_OR_UI, "menu hover"],
  // Title text is VT323 20px bold (large text), so 3:1 applies at the lighter gradient end.
  ["chrome-highlight", "title-to", LARGE_OR_UI, "title text, right end of gradient (large bold)"],
  ["chrome-highlight", "title-to", LARGE_OR_UI, "focus ring of the title-bar close button"],
  // web-client-pixel-match R10.1: IRC colours without a background on the ghost background.
  ...Array.from({ length: 16 }, (_, i) => [`irc-fg-${i}`, "ghost-bg", BODY, `IRC colour ${i} in chat`] as const),
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

// ---------------------------------------------------------------------------------------------
// web-client-extras R3.4: every text/background pair of the Classic theme reaches 4.5:1.

function classicTok(name: string): string {
  const v = classicTokens.get(name);
  if (v === undefined) throw new Error(`token --color-${name} not found for the Classic theme`);
  return v;
}

/** `fg` at `alpha` over `bg`, as hex. */
function over(fg: string, bg: string, alpha: number): string {
  const a = Number.parseInt(fg.slice(1), 16);
  const b = Number.parseInt(bg.slice(1), 16);
  const mix = (shift: number): string =>
    Math.round(((a >> shift) & 255) * alpha + ((b >> shift) & 255) * (1 - alpha))
      .toString(16)
      .padStart(2, "0");
  return `#${mix(16)}${mix(8)}${mix(0)}`;
}

const CLASSIC_TEXT = [
  "ghost-text",
  "ghost-orange",
  "ghost-green",
  "ghost-purple",
  "link-blue",
  "timestamp-dim",
  "action-purple",
  "event-green",
  "tool-grey",
  "away-grey",
  "nick-coder",
  "nick-reviewer",
  "nick-researcher",
  "nick-human",
  ...Array.from({ length: 16 }, (_, i) => `irc-fg-${i}`),
] as const;

describe("WCAG contrast of the Classic theme", () => {
  it("overrides the surfaces with the Figma frame 06 values", () => {
    expect(classicTok("ghost-bg")).toBe("#ffffff");
    expect(classicTok("mention-fill")).toBe("#ffe2b0");
    // Chrome is identical to Ghost (frame 06 uses the same title bar, toolbar and status bar).
    expect(classicTok("chrome-face")).toBe(tok("chrome-face"));
  });

  it.each(CLASSIC_TEXT)("%s reaches 4.5:1 on the white chat surface", (name) => {
    expect(contrast(classicTok(name), classicTok("ghost-bg"))).toBeGreaterThanOrEqual(BODY);
  });

  it.each(CLASSIC_TEXT)("%s reaches 4.5:1 on the mention fill", (name) => {
    expect(contrast(classicTok(name), classicTok("mention-fill"))).toBeGreaterThanOrEqual(BODY);
  });

  it("the accent reaches 4.5:1 on its own 20 % fill (exorcised lines)", () => {
    const fill = over(classicTok("ghost-orange"), classicTok("ghost-bg"), 0.2);
    expect(contrast(classicTok("ghost-orange"), fill)).toBeGreaterThanOrEqual(BODY);
  });

  it("the mention bar reaches 3:1 on white (non-text)", () => {
    expect(contrast(classicTok("mention-bar"), classicTok("ghost-bg"))).toBeGreaterThanOrEqual(LARGE_OR_UI);
  });

  it("focus ring on the white chat surface reaches 3:1", () => {
    expect(contrast(classicTok("ghost-orange"), classicTok("ghost-bg"))).toBeGreaterThanOrEqual(LARGE_OR_UI);
  });

  it("selected list row (white on navy) reaches 4.5:1", () => {
    expect(contrast(classicTok("chrome-highlight"), classicTok("title-from"))).toBeGreaterThanOrEqual(BODY);
  });
});
