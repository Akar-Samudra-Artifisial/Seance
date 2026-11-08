// Feature: web-client-pixel-match, Property 1: Icon fidelity
// **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.8**
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "@testing-library/react";
import { createElement } from "react";
import type { ComponentType } from "react";
import { describe, expect, it } from "vitest";
import * as Icons from "./index.js";
import type { IconProps } from "./types.js";
import { ICON_SOURCES, SCROLL_PARTS } from "./sources.js";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "../..");

type PathAttrs = Readonly<Record<string, string>>;

/** The `<path>` attributes of a source SVG, in order, with names in SVG spelling. */
function sourcePaths(text: string): PathAttrs[] {
  return [...text.matchAll(/<path\b([^>]*?)\/>/g)].map((m) =>
    Object.fromEntries([...(m[1] ?? "").matchAll(/([a-zA-Z:-]+)="([^"]*)"/g)].map((a) => [a[1] ?? "", a[2] ?? ""])),
  );
}

function renderedPaths(el: Element): PathAttrs[] {
  return Array.from(el.querySelectorAll("path")).map((p) =>
    Object.fromEntries(Array.from(p.attributes).map((a) => [a.name, a.value])),
  );
}

const components = Icons as unknown as Readonly<Record<string, ComponentType<IconProps>>>;

describe("P1 icon fidelity", () => {
  it.each(ICON_SOURCES.map((s) => [s.component, s] as const))("%s keeps every path and colour of its source", (name, src) => {
    const Comp = components[name];
    expect(Comp, `component ${name} is exported`).toBeDefined();
    if (Comp === undefined) return;
    const { container } = render(createElement(Comp));
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    if (svg === null) return;

    const text = readFileSync(join(WEB, "design", src.file), "utf8");
    let expected = sourcePaths(text);
    if ("slice" in src && src.slice === true) expected = expected.filter((p) => p["fill"] === "#C8761F");
    const swap = src.currentColor;
    const actual = renderedPaths(svg).map((p) =>
      Object.fromEntries(Object.entries(p).map(([k, v]) => [k, swap !== null && v === "currentColor" ? swap : v])),
    );
    expect(actual).toEqual(expected);

    // R3.2: viewBox kept, no width/height/style/text, crisp, hidden from assistive tech.
    expect(svg.getAttribute("viewBox")).toBe(src.viewBox);
    expect(svg.hasAttribute("width")).toBe(false);
    expect(svg.hasAttribute("height")).toBe(false);
    expect(svg.getAttribute("shape-rendering")).toBe("crispEdges");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("focusable")).toBe("false");
    expect(container.querySelector("[style]")).toBeNull();
    expect(container.querySelector("text")).toBeNull();
  });

  it("uses currentColor only for the two single-colour icons", () => {
    const swapped = ICON_SOURCES.filter((s) => s.currentColor !== null).map((s) => s.component);
    expect(swapped.sort()).toEqual(["MdiChildChannel", "SwitchChannel"]);
  });

  it("builds every scrollbar part from whole paths of its source file", () => {
    const css = readFileSync(join(WEB, "app/scrollbar.css"), "utf8");
    for (const part of SCROLL_PARTS) {
      const m = new RegExp(`--scroll-${part.name}: url\\("data:image/svg\\+xml,([^"]+)"\\)`).exec(css);
      expect(m, `--scroll-${part.name} exists`).not.toBeNull();
      const svg = decodeURIComponent(m?.[1] ?? "");
      expect(svg).not.toMatch(/style=|<text/);
      const dir = part.file.startsWith("scroll-arrow-") ? "figma-icons-extra" : "figma-icons";
      const source = sourcePaths(readFileSync(join(WEB, "design", dir, part.file), "utf8"));
      const used = sourcePaths(svg);
      expect(used).toHaveLength(part.paths);
      for (const p of used) expect(source).toContainEqual(p);
    }
  });
});
