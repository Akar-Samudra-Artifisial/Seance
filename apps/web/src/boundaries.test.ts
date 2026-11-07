import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|css)$/.test(name)) out.push(full);
  }
  return out;
}

const isTest = (f: string): boolean => /\.test\.tsx?$/.test(f);

describe("web client boundaries", () => {
  it("src/irc imports only @seance/irc-protocol and relative files", () => {
    const importRe = /(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g;
    const bad: string[] = [];
    for (const file of walk(join(webRoot, "src", "irc")).filter((f) => !isTest(f))) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(importRe)) {
        const spec = m[1] ?? "";
        if (spec !== "@seance/irc-protocol" && !spec.startsWith("./") && !spec.startsWith("../")) {
          bad.push(`${file}: ${spec}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("no source under app/ or src/ contains the word mIRC", () => {
    const files = [...walk(join(webRoot, "app")), ...walk(join(webRoot, "src"))].filter(
      (f) => !isTest(f),
    );
    // Comments are not UI text; strip block and line comments before checking.
    const stripComments = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    const offenders = files.filter((f) => /\bmirc\b/i.test(stripComments(readFileSync(f, "utf8"))));
    expect(offenders).toEqual([]);
  });
});
