// Hardening of scripts/gen-icons.mjs: only allowlisted path attributes, strict parsing, escaped values.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PATH_ATTRS, escapeAttr, parseAttrs, parseSvg, pathJsx, svgString } from "./gen-icons.mjs";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const svg = (paths) => `<svg viewBox="0 0 16 16" fill="none">${paths}</svg>`;

describe("gen-icons path attribute allowlist", () => {
  it("allows exactly the listed presentation attributes", () => {
    expect([...PATH_ATTRS].sort()).toEqual(
      ["clip-rule", "d", "fill", "fill-rule", "opacity", "stroke", "stroke-linecap", "stroke-linejoin", "stroke-width"].sort(),
    );
  });

  it.each(["style", "onload", "transform", "href", "xlink:href", "class", "id"])("throws on a path with %s", (name) => {
    expect(() => parseSvg(svg(`<path d="M0 0H1V1Z" ${name}="x"/>`), "bad.svg")).toThrow(
      new RegExp(`bad\\.svg <path> #1 has attribute "${name}"`),
    );
  });

  it("throws on attributes it cannot parse (single quotes, bare names) instead of dropping them", () => {
    expect(() => parseSvg(svg(`<path d="M0 0H1V1Z" onclick='x'/>`), "q.svg")).toThrow(/cannot parse attributes/);
    expect(() => parseSvg(svg(`<path d="M0 0H1V1Z" hidden/>`), "b.svg")).toThrow(/cannot parse attributes/);
  });

  it("throws on duplicates, a missing d and a path that is not self-closing", () => {
    expect(() => parseSvg(svg(`<path d="M0 0Z" d="M1 1Z"/>`), "dup.svg")).toThrow(/duplicate attribute d/);
    expect(() => parseSvg(svg(`<path fill="black"/>`), "nod.svg")).toThrow(/has no path data/);
    expect(() => parseSvg(svg(`<path d="M0 0Z"></path>`), "open.svg")).toThrow(/not self-closing/);
  });

  it("accepts every committed source file", () => {
    for (const dir of ["design/figma-icons", "design/figma-icons-extra"]) {
      for (const f of readdirSync(join(WEB, dir)).filter((n) => n.endsWith(".svg"))) {
        const parsed = parseSvg(readFileSync(join(WEB, dir, f), "utf8"), f);
        expect(parsed.paths.length, f).toBeGreaterThan(0);
      }
    }
  });
});

describe("gen-icons value escaping", () => {
  it("escapes &, \", < and > for JSX and XML attributes", () => {
    expect(escapeAttr(`a&b"c<d>e`)).toBe("a&amp;b&quot;c&lt;d&gt;e");
  });

  it("never lets a value close the attribute in the JSX or the data-URI SVG", () => {
    // parseAttrs cannot yield a raw quote; this checks the writers on their own.
    const attrs = { d: "M0 0Z", fill: `red" onload="x` };
    expect(pathJsx(attrs, undefined)).toBe(`<path d="M0 0Z" fill="red&quot; onload=&quot;x" />`);
    expect(svgString([0, 0, 16, 16], [{ attrs }])).toContain(`fill="red&quot; onload=&quot;x"`);
  });

  it("parses the strict form back to the same values", () => {
    expect(parseAttrs(` d="M1 2H3" fill="#C0C0C0" `, "t")).toEqual({ d: "M1 2H3", fill: "#C0C0C0" });
    expect(parseAttrs(` d="M1 2H3"/`, "t")).toEqual({ d: "M1 2H3" });
  });
});
