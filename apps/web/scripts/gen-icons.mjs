// Generates React icon components and the scrollbar CSS from the committed Figma SVGs.
//
//   node scripts/gen-icons.mjs
//
// Sources: design/figma-icons/*.svg (exported from Figma, never edited) and
// design/figma-icons-extra/*.svg (drawn for states the Figma set lacks).
// Output (committed, do not edit by hand):
//   src/icons/<Name>.tsx, src/icons/index.ts, src/icons/sources.ts, app/scrollbar.css
//
// Path data and colours are copied unchanged. The script only drops width/height, adds
// shape-rendering="crispEdges", aria-hidden and focusable, renames attributes for JSX, and
// cuts composite files into slices by choosing whole paths and a viewBox.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIRS = [join(WEB, "design/figma-icons"), join(WEB, "design/figma-icons-extra")];
const OUT = join(WEB, "src/icons");
const CSS_OUT = join(WEB, "app/scrollbar.css");

/** Files that are not shipped as one component. */
const SKIP = new Set(["caption-buttons", "scrollbar-vertical", "scrollbar-horizontal", "credits-candle"]);

/** Single-colour icons whose fill becomes currentColor, with the token class that restores it. */
const CURRENT_COLOR = {
  "mdi-child-channel": { colour: "#000080", className: "text-title-from" },
  "switch-channel": { colour: "black", className: "" },
};

/** Slices: component name, source file, viewBox (x y w h), and a path filter. */
const SLICES = [
  { name: "credits-candle-slice", file: "credits-candle", box: [6.5, 5.5, 11, 11], keep: (p) => p.attrs.fill === "#C8761F" },
];

/** Scrollbar parts for CSS: source file and the 16x16 box of each arrow button. */
const SCROLL_PARTS = [
  { name: "arrow-up", file: "scrollbar-vertical", box: [0, 0, 16, 16] },
  { name: "arrow-down", file: "scrollbar-vertical", box: [0, 104, 16, 16] },
  { name: "arrow-left", file: "scrollbar-horizontal", box: [0, 0, 16, 16] },
  { name: "arrow-right", file: "scrollbar-horizontal", box: [444, 0, 16, 16] },
];
const SCROLL_PRESSED = ["up", "down", "left", "right"].map((d) => ({ name: `arrow-${d}-pressed`, file: `scroll-arrow-${d}-pressed` }));

const JSX_ATTR = {
  "stroke-width": "strokeWidth",
  "stroke-linejoin": "strokeLinejoin",
  "stroke-linecap": "strokeLinecap",
  "fill-rule": "fillRule",
  "clip-rule": "clipRule",
};

function findSource(file) {
  for (const dir of SOURCE_DIRS) {
    const names = readdirSync(dir);
    if (names.includes(`${file}.svg`)) return join(dir, `${file}.svg`);
  }
  throw new Error(`gen-icons: no source SVG named ${file}.svg in ${SOURCE_DIRS.join(", ")}`);
}

function parseAttrs(s) {
  const attrs = {};
  for (const m of s.matchAll(/([a-zA-Z:-]+)="([^"]*)"/g)) attrs[m[1]] = m[2];
  return attrs;
}

/** Root viewBox and the <path> elements, in document order. Other elements are reported. */
function parseSvg(text, file) {
  const root = /<svg\b([^>]*)>/.exec(text);
  if (root === null) throw new Error(`gen-icons: ${file} has no <svg> element`);
  const rootAttrs = parseAttrs(root[1]);
  const paths = [...text.matchAll(/<path\b([^>]*?)\/>/g)].map((m) => ({ attrs: parseAttrs(m[1]) }));
  const others = [...text.matchAll(/<(text|rect|circle|g|image|use)\b/g)].map((m) => m[1]);
  return { viewBox: rootAttrs.viewBox, rootFill: rootAttrs.fill, paths, others };
}

/** Bounding box of an absolute M/L/H/V/C/Z path (the Figma exports use only these). */
function bbox(d) {
  const tokens = d.match(/[MLHVCZ]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
  let cmd = "";
  let x = 0;
  let y = 0;
  const xs = [];
  const ys = [];
  const nums = [];
  const flush = () => {
    if (cmd === "H") for (const n of nums.splice(0)) { x = n; xs.push(x); }
    else if (cmd === "V") for (const n of nums.splice(0)) { y = n; ys.push(y); }
    else while (nums.length >= 2) { x = nums.shift(); y = nums.shift(); xs.push(x); ys.push(y); }
    nums.length = 0;
  };
  for (const t of tokens) {
    if (/[MLHVCZ]/.test(t)) { flush(); cmd = t; } else nums.push(Number(t));
  }
  flush();
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

const inside = (b, [x, y, w, h]) => b.x0 >= x && b.y0 >= y && b.x1 <= x + w && b.y1 <= y + h;

const pascal = (kebab) => kebab.split("-").map((p) => p[0].toUpperCase() + p.slice(1)).join("");

function pathJsx(attrs, swap) {
  const parts = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "style") throw new Error("gen-icons: a path carries a style attribute");
    const value = swap !== undefined && (k === "fill" || k === "stroke") && v === swap ? "currentColor" : v;
    parts.push(`${JSX_ATTR[k] ?? k}="${value}"`);
  }
  return `<path ${parts.join(" ")} />`;
}

function sizeClass(box) {
  return `w-[${box[2]}px] h-[${box[3]}px]`;
}

function component(name, file, box, paths, extraClass, swap) {
  const comp = pascal(name);
  const defaults = [sizeClass(box), "inline-block shrink-0", extraClass].filter(Boolean).join(" ");
  const body = paths.map((p) => `      ${pathJsx(p.attrs, swap)}`).join("\n");
  return `// Generated by scripts/gen-icons.mjs from ${file}.svg. Do not edit by hand.
import type { ReactNode } from "react";
import type { IconProps } from "./types.js";

/** ${name} (${box[2]}x${box[3]}). Decorative: always aria-hidden; the owning control names it. */
export function ${comp}({ className }: IconProps): ReactNode {
  return (
    <svg
      viewBox="${box.join(" ")}"
      fill="none"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
      data-icon="${name}"
      className={className ?? "${defaults}"}
    >
${body}
    </svg>
  );
}
`;
}

function svgString(box, paths) {
  const body = paths.map((p) => `<path ${Object.entries(p.attrs).map(([k, v]) => `${k}="${v}"`).join(" ")}/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.join(" ")}" width="16" height="16" shape-rendering="crispEdges">${body}</svg>`;
}

const dataUri = (svg) => `url("data:image/svg+xml,${encodeURIComponent(svg).replace(/'/g, "%27")}")`;

mkdirSync(OUT, { recursive: true });
const index = [];
const manifest = [];

for (const dir of SOURCE_DIRS) {
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".svg")).sort()) {
    const file = f.slice(0, -4);
    if (SKIP.has(file) || file.startsWith("scroll-arrow-")) continue;
    const svg = parseSvg(readFileSync(join(dir, f), "utf8"), f);
    if (svg.others.length > 0) throw new Error(`gen-icons: ${f} has non-path elements: ${svg.others.join(", ")}`);
    const box = svg.viewBox.split(/\s+/).map(Number);
    const cc = CURRENT_COLOR[file];
    writeFileSync(join(OUT, `${pascal(file)}.tsx`), component(file, file, box, svg.paths, cc?.className ?? "", cc?.colour));
    index.push(`export { ${pascal(file)} } from "./${pascal(file)}.js";`);
    manifest.push({ component: pascal(file), file: `${dir.endsWith("extra") ? "figma-icons-extra" : "figma-icons"}/${f}`, viewBox: svg.viewBox, currentColor: cc?.colour ?? null, paths: svg.paths.length });
  }
}

for (const s of SLICES) {
  const svg = parseSvg(readFileSync(findSource(s.file), "utf8"), s.file);
  const paths = svg.paths.filter(s.keep);
  if (paths.length === 0) throw new Error(`gen-icons: slice ${s.name} selected no path`);
  writeFileSync(join(OUT, `${pascal(s.name)}.tsx`), component(s.name, s.file, s.box, paths, "", undefined));
  index.push(`export { ${pascal(s.name)} } from "./${pascal(s.name)}.js";`);
  manifest.push({ component: pascal(s.name), file: `figma-icons/${s.file}.svg`, viewBox: s.box.join(" "), currentColor: null, paths: paths.length, slice: true });
}

const cssParts = [];
for (const s of SCROLL_PARTS) {
  const svg = parseSvg(readFileSync(findSource(s.file), "utf8"), s.file);
  const paths = svg.paths.filter((p) => inside(bbox(p.attrs.d), s.box));
  if (paths.length === 0) throw new Error(`gen-icons: scroll part ${s.name} selected no path`);
  cssParts.push({ name: s.name, uri: dataUri(svgString(s.box, paths)), file: `${s.file}.svg`, paths: paths.length });
}
for (const s of SCROLL_PRESSED) {
  const svg = parseSvg(readFileSync(findSource(s.file), "utf8"), s.file);
  cssParts.push({ name: s.name, uri: dataUri(svgString([0, 0, 16, 16], svg.paths)), file: `${s.file}.svg`, paths: svg.paths.length });
}

writeFileSync(
  join(OUT, "types.ts"),
  `// Generated by scripts/gen-icons.mjs. Do not edit by hand.
export interface IconProps {
  /** Replaces the default size class (the natural Figma size). */
  readonly className?: string;
}
`,
);
writeFileSync(join(OUT, "index.ts"), `// Generated by scripts/gen-icons.mjs. Do not edit by hand.\nexport type { IconProps } from "./types.js";\n${index.sort().join("\n")}\n`);
writeFileSync(
  join(OUT, "sources.ts"),
  `// Generated by scripts/gen-icons.mjs. Do not edit by hand. Used by the icon fidelity test.\nexport const ICON_SOURCES = ${JSON.stringify(manifest, null, 2)} as const;\nexport const SCROLL_PARTS = ${JSON.stringify(cssParts.map(({ name, file, paths }) => ({ name, file, paths })), null, 2)} as const;\n`,
);

const vars = cssParts.map((p) => `  --scroll-${p.name}: ${p.uri};`).join("\n");
writeFileSync(
  CSS_OUT,
  `/* Generated by scripts/gen-icons.mjs from the Figma scrollbar SVGs. Do not edit by hand. */
:root {
${vars}
}
`,
);
console.log(`gen-icons: ${index.length} components, ${cssParts.length} scrollbar parts`);
