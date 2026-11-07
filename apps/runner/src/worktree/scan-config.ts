import { readdir } from "node:fs/promises";
import { join } from "node:path";

const CONFIG_NAMES: ReadonlySet<string> = new Set(["agents.md", ".kiro"]);

/**
 * Walks the whole worktree and returns the relative paths (sorted) of every
 * entry, file, directory or symlink, whose lower-cased name is `agents.md` or
 * `.kiro`. Never follows symlinks, skips only the root `.git` entry and does
 * not descend into a `.kiro` it has found.
 */
export async function scanConfig(root: string): Promise<readonly string[]> {
  const found: string[] = [];
  const pending: string[] = [""];

  while (pending.length > 0) {
    const rel = pending.pop();
    if (rel === undefined) break;
    const dir = rel === "" ? root : join(root, rel);
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (rel === "" && entry.name === ".git") continue;
      const entryRel = rel === "" ? entry.name : join(rel, entry.name);
      const lower = entry.name.toLowerCase();
      if (CONFIG_NAMES.has(lower)) {
        found.push(entryRel);
        if (lower === ".kiro") continue;
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(entryRel);
    }
  }

  return found.sort();
}
