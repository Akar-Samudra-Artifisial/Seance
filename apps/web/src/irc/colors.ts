// Readable IRC colours. Pure: no DOM, no React. The hex values mirror app/globals.css
// (a test keeps them equal); components only ever see class names from fixed lists.

/** Background of the chat surfaces (`--color-ghost-bg`). */
export const GHOST_BG = "#0b0b0f";

/** Classic IRC palette (`--color-irc-N`): backgrounds and colour pairs. */
export const IRC_PALETTE = [
  "#ffffff", "#000000", "#00007f", "#009300", "#ff0000", "#7f0000", "#9c009c", "#fc7f00",
  "#ffff00", "#00fc00", "#009393", "#00ffff", "#0000fc", "#ff00ff", "#7f7f7f", "#d2d2d2",
] as const;

/** Foregrounds without a background (`--color-irc-fg-N`), each >= 4.5:1 on GHOST_BG. */
export const IRC_FG = [
  "#ffffff", "#7a7a7a", "#4274ea", "#009300", "#ff0000", "#ca5345", "#c43ec3", "#fc7f00",
  "#ffff00", "#00fc00", "#009393", "#00ffff", "#2370ff", "#ff00ff", "#7f7f7f", "#d2d2d2",
] as const;

export const READABLE_RATIO = 4.5;

/** Black and white used when a colour pair would be unreadable (`--color-chrome-*`). */
export const PAIR_FALLBACK = { white: "#ffffff", black: "#000000" } as const;

// Full class literals so Tailwind sees every name at build time.
const FG_ALONE: readonly string[] = [
  "text-irc-fg-0", "text-irc-fg-1", "text-irc-fg-2", "text-irc-fg-3", "text-irc-fg-4", "text-irc-fg-5",
  "text-irc-fg-6", "text-irc-fg-7", "text-irc-fg-8", "text-irc-fg-9", "text-irc-fg-10", "text-irc-fg-11",
  "text-irc-fg-12", "text-irc-fg-13", "text-irc-fg-14", "text-irc-fg-15",
];
const FG_PAIRED: readonly string[] = [
  "text-irc-0", "text-irc-1", "text-irc-2", "text-irc-3", "text-irc-4", "text-irc-5", "text-irc-6",
  "text-irc-7", "text-irc-8", "text-irc-9", "text-irc-10", "text-irc-11", "text-irc-12", "text-irc-13",
  "text-irc-14", "text-irc-15",
];
export const FALLBACK_WHITE = "text-chrome-highlight";
export const FALLBACK_BLACK = "text-chrome-outline";

/** Every class `readableClass` can return. */
export const READABLE_CLASSES: readonly string[] = [...FG_ALONE, ...FG_PAIRED, FALLBACK_WHITE, FALLBACK_BLACK];

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG contrast ratio of two `#rrggbb` colours. */
export function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Hex value behind a class returned by `readableClass`; undefined for an unknown class. */
export function colourOfClass(cls: string): string | undefined {
  if (cls === FALLBACK_WHITE) return PAIR_FALLBACK.white;
  if (cls === FALLBACK_BLACK) return PAIR_FALLBACK.black;
  const alone = FG_ALONE.indexOf(cls);
  if (alone !== -1) return IRC_FG[alone];
  const paired = FG_PAIRED.indexOf(cls);
  return paired === -1 ? undefined : IRC_PALETTE[paired];
}

/**
 * Text class for IRC colour `fg` (0..15) on background `bg` (0..15, or undefined for the ghost
 * background). Without a background the readable shade is used. With one, the classic colour
 * is kept when the pair meets 4.5:1, otherwise white or black, whichever contrasts more.
 */
export function readableClass(fg: number, bg: number | undefined): string {
  if (bg === undefined) return FG_ALONE[fg] ?? FG_ALONE[0] ?? FALLBACK_WHITE;
  const fgHex = IRC_PALETTE[fg];
  const bgHex = IRC_PALETTE[bg];
  const paired = FG_PAIRED[fg];
  if (fgHex === undefined || bgHex === undefined || paired === undefined) return FALLBACK_WHITE;
  if (contrast(fgHex, bgHex) >= READABLE_RATIO) return paired;
  return contrast(PAIR_FALLBACK.white, bgHex) >= contrast(PAIR_FALLBACK.black, bgHex) ? FALLBACK_WHITE : FALLBACK_BLACK;
}
