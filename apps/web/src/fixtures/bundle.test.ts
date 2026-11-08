// Task 8.4 (R13.6): a normal build has no fixture code; the e2e build has it. Each check reads the
// build output when it exists (run `pnpm build` or the e2e harness first) and is skipped otherwise.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FIXTURE_MARKER } from "./figma-01-main.js";

const WEB_DIR = fileURLToPath(new URL("../..", import.meta.url));

/** Files under `dir` whose content contains `needle` (text files only, cache folders skipped). */
function filesContaining(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (at: string): void => {
    for (const name of readdirSync(at)) {
      if (name === "cache") continue;
      const path = join(at, name);
      const info = statSync(path);
      if (info.isDirectory()) walk(path);
      else if (/\.(js|mjs|cjs|json|html|rsc|txt|map)$/.test(name) && readFileSync(path, "utf8").includes(needle)) {
        hits.push(path);
      }
    }
  };
  walk(dir);
  return hits;
}

const prod = join(WEB_DIR, ".next");
const e2e = join(WEB_DIR, ".next-e2e");

describe("fixture route only in the e2e build", () => {
  it.skipIf(!existsSync(join(prod, "BUILD_ID")))("the normal build (.next) has no fixture marker", () => {
    expect(filesContaining(prod, FIXTURE_MARKER)).toEqual([]);
  });

  it.skipIf(!existsSync(join(e2e, "BUILD_ID")))("the e2e build (.next-e2e) contains the fixture marker", () => {
    expect(filesContaining(e2e, FIXTURE_MARKER).length).toBeGreaterThan(0);
  });
});
