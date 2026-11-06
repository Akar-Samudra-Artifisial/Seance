import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Feature: ircd-agent-commands-fixes, Finding 5 (exploration): duplicated reply helpers.
// Requirement 1.11. Same source-scan style as numeric-literals.test.ts. Written before the fix.

const WANTED: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["away.ts", ["numeric"]],
  ["message.ts", ["numeric", "prefixOf"]],
  ["registration.ts", ["numeric"]],
];

function read(file: string): string {
  const path = fileURLToPath(new URL(`../src/handlers/${file}`, import.meta.url));
  // Blank out comments (keeping line breaks) so doc text is not flagged.
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/^(\s*)\/\/.*$/gm, "$1");
}

function importedFromReplies(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"\.\.\/replies\.js"/g)) {
    for (const part of (m[1] ?? "").split(",")) {
      const name = part.trim().replace(/^type\s+/, "");
      if (name !== "") names.push(name);
    }
  }
  return names;
}

describe("handler source: shared reply helpers", () => {
  for (const [file, helpers] of WANTED) {
    for (const helper of helpers) {
      it(`${file} defines no local ${helper}`, () => {
        const source = read(file);
        const local = new RegExp(`(function\\s+${helper}\\b|(?:const|let)\\s+${helper}\\s*=)`);
        expect(local.test(source)).toBe(false);
      });
      it(`${file} imports ${helper} from ../replies.js`, () => {
        expect(importedFromReplies(read(file))).toContain(helper);
      });
    }
  }
});
