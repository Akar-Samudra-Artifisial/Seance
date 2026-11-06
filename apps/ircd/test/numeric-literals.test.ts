import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Requirement 11.2: handlers must use `Numerics` constants, never quoted numeric literals.
const FILES = ["away.ts", "whois.ts", "invite.ts"] as const;
const QUOTED_NUMERIC = /(["'`])\d{3}\1/g;

describe("handler source: no string-literal numerics", () => {
  for (const file of FILES) {
    it(`${file} contains no quoted three-digit numeric literal`, () => {
      const path = fileURLToPath(new URL(`../src/handlers/${file}`, import.meta.url));
      // Blank out comments (keeping line breaks) so doc text such as `312` is not flagged.
      const source = readFileSync(path, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
        .replace(/^(\s*)\/\/.*$/gm, "$1");
      const hits: string[] = [];
      source.split("\n").forEach((line, index) => {
        for (const match of line.matchAll(QUOTED_NUMERIC)) {
          hits.push(`${file}:${index + 1}: ${match[0]}`);
        }
      });
      expect(hits).toEqual([]);
    });
  }
});
