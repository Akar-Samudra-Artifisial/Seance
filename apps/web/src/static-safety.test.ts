import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const rel = (f: string): string => relative(webRoot, f).split("\\").join("/");
const isTest = (f: string): boolean => /\.test\.[cm]?[jt]sx?$/.test(f);
const isCode = (f: string): boolean => /\.(ts|tsx)$/.test(f);

const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const sources = [...walk(join(webRoot, "app")), ...walk(join(webRoot, "src"))].filter(
  (f) => !isTest(f),
);
const codeSources = sources.filter(isCode);

function offenders(files: readonly string[], re: RegExp): string[] {
  return files.filter((f) => re.test(stripComments(readFileSync(f, "utf8")))).map(rel);
}

describe("static safety checks", () => {
  it("never uses dangerouslySetInnerHTML or innerHTML", () => {
    expect(offenders(codeSources, /dangerouslySetInnerHTML|\binnerHTML\b/)).toEqual([]);
  });

  it("never calls eval", () => {
    expect(offenders(codeSources, /\beval\s*\(/)).toEqual([]);
  });

  it("uses no inline style props in .tsx", () => {
    expect(
      offenders(
        codeSources.filter((f) => f.endsWith(".tsx")),
        /\bstyle\s*=\s*\{/,
      ),
    ).toEqual([]);
  });

  it("hardcodes no hex colours in components", () => {
    const appDir = join(webRoot, "app");
    const components = codeSources.filter((f) => {
      const r = rel(f);
      return (
        r.startsWith("src/components/") ||
        (r.startsWith("app/") && r.endsWith(".tsx") && dirname(f) === appDir)
      );
    });
    expect(offenders(components, /#[0-9a-fA-F]{3,8}\b/)).toEqual([]);
  });

  it('never uses the standalone word "mIRC"', () => {
    expect(offenders(sources.filter((f) => /\.(ts|tsx|css)$/.test(f)), /\bmirc\b/i)).toEqual([]);
  });

  it("sets no font size below 11px in component class lists", () => {
    const components = codeSources.filter(
      (f) => f.endsWith(".tsx") && (rel(f).startsWith("src/components/") || rel(f).startsWith("app/")),
    );
    const small: string[] = [];
    for (const f of components) {
      const text = stripComments(readFileSync(f, "utf8"));
      for (const m of text.matchAll(/\btext-\[(\d+(?:\.\d+)?)(px|rem|em)\]/g)) {
        const value = Number(m[1]);
        const px = m[2] === "px" ? value : value * 16;
        if (px < 11) small.push(`${rel(f)}: ${m[0]}`);
      }
    }
    expect(small).toEqual([]);
  });

  it("has no app/api directory or route handlers", () => {
    expect(existsSync(join(webRoot, "app", "api"))).toBe(false);
    const routes = [...walk(join(webRoot, "app")), ...walk(join(webRoot, "src"))]
      .filter((f) => /(^|\/)route\.[cm]?[jt]sx?$/.test(rel(f)))
      .map(rel);
    expect(routes).toEqual([]);
  });

  it("references parseInput only in the Store and src/irc", () => {
    const refs = offenders(codeSources, /\bparseInput\b/);
    const bad = refs.filter((r) => r !== "src/store/client-store.ts" && !r.startsWith("src/irc/"));
    expect(bad).toEqual([]);
  });
});
