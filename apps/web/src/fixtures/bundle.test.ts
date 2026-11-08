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

/**
 * Locally a missing build output skips the check. With CI=true it fails: CI must build both outputs
 * first (`pnpm build`, then the e2e harness), so the check can never pass by being skipped.
 */
function bundleCheckMode(dir: string, env: Readonly<Record<string, string | undefined>>): "run" | "skip" | "fail" {
  if (existsSync(join(dir, "BUILD_ID"))) return "run";
  return env["CI"] === "true" ? "fail" : "skip";
}

function check(name: string, dir: string, assert: () => void): void {
  const mode = bundleCheckMode(dir, process.env);
  it.skipIf(mode === "skip")(name, () => {
    if (mode === "fail") {
      throw new Error(`CI=true but ${dir} has no BUILD_ID: build it before the tests so this check runs`);
    }
    assert();
  });
}

describe("fixture route only in the e2e build", () => {
  check("the normal build (.next) has no fixture marker", prod, () => {
    expect(filesContaining(prod, FIXTURE_MARKER)).toEqual([]);
  });

  check("the e2e build (.next-e2e) contains the fixture marker", e2e, () => {
    expect(filesContaining(e2e, FIXTURE_MARKER).length).toBeGreaterThan(0);
  });
});

describe("bundleCheckMode", () => {
  const missing = join(WEB_DIR, ".no-such-build-output");
  it("runs when the output exists, skips locally and fails on CI when it does not", () => {
    expect(bundleCheckMode(missing, {})).toBe("skip");
    expect(bundleCheckMode(missing, { CI: "false" })).toBe("skip");
    expect(bundleCheckMode(missing, { CI: "true" })).toBe("fail");
    if (existsSync(join(prod, "BUILD_ID"))) expect(bundleCheckMode(prod, { CI: "true" })).toBe("run");
  });
});
