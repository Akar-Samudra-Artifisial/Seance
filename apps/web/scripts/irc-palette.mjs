// Computes readable foreground shades of the 16 IRC colours on the ghost background.
//
//   node scripts/irc-palette.mjs            (ghost background, lightness raised)
//   node scripts/irc-palette.mjs --classic   (white and the mention fill, lightness lowered)
//
// For each colour below 4.5:1 on #0b0b0f, keep OKLCH hue and chroma and raise lightness in
// 0.01 steps until the ratio is met (channels clamped to sRGB). Prints CSS lines for
// `--color-irc-fg-N` and the TypeScript array for src/irc/colors.ts. Not run at build time.
const CLASSIC = process.argv.includes("--classic");
// Classic: a colour must reach the floor on the white chat surface and on the mention fill.
const BGS = CLASSIC ? ["#ffffff", "#ffe2b0"] : ["#0b0b0f"];
const BG = BGS[0];
const worst = (hex) => Math.min(...BGS.map((bg) => contrast(hex, bg)));
const PALETTE = [
  "#ffffff", "#000000", "#00007f", "#009300", "#ff0000", "#7f0000", "#9c009c", "#fc7f00",
  "#ffff00", "#00fc00", "#009393", "#00ffff", "#0000fc", "#ff00ff", "#7f7f7f", "#d2d2d2",
];
const FLOOR = 4.5;

const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const toHex = (rgb) => `#${rgb.map((c) => Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, "0")).join("")}`;
const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const lum = (h) => {
  const [r, g, b] = hexToRgb(h).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

function toOklch(hex) {
  const [r, g, b] = hexToRgb(hex).map(lin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), Math.atan2(B, A)];
}

function fromOklch([L, C, H]) {
  const A = C * Math.cos(H);
  const B = C * Math.sin(H);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return toHex(rgb.map((c) => gam(Math.min(1, Math.max(0, c)))));
}

const out = PALETTE.map((hex, i) => {
  if (worst(hex) >= FLOOR) return { i, hex, from: null };
  const [L, C, H] = toOklch(hex);
  if (CLASSIC) {
    for (let step = L; step >= -0.0001; step -= 0.01) {
      const candidate = fromOklch([Math.max(step, 0), C, H]);
      if (worst(candidate) >= FLOOR) return { i, hex: candidate, from: hex };
    }
    return { i, hex: "#000000", from: hex };
  }
  for (let step = L; step <= 1.0001; step += 0.01) {
    const candidate = fromOklch([step, C, H]);
    if (contrast(candidate, BG) >= FLOOR) return { i, hex: candidate, from: hex };
  }
  return { i, hex: "#ffffff", from: hex };
});

for (const o of out) {
  const note = o.from === null ? "" : ` /* lifted from ${o.from}: ${worst(o.from).toFixed(2)}:1 -> ${worst(o.hex).toFixed(2)}:1 */`;
  console.log(`  --color-irc-fg-${o.i}: ${o.hex};${note}`);
}
if (!CLASSIC) console.log(`export const IRC_FG = [${out.map((o) => JSON.stringify(o.hex)).join(", ")}] as const;`);
