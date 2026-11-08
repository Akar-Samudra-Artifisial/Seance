import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** Entries refused at any depth, compared in lower case: agent instructions and git submodule config. */
const CONFIG_NAMES: ReadonlySet<string> = new Set(["agents.md", ".kiro", ".gitmodules"]);

/**
 * Walks the whole worktree and returns the relative paths (sorted) of every refused entry (file,
 * directory or symlink): a name whose lower case is `agents.md`, `.kiro` or `.gitmodules`, and any
 * `.git` below the root (a nested repository, as a directory or a `gitdir:` file; agent-sandbox
 * review finding 1). Its config is agent-controlled input that host git would otherwise honour
 * (`core.fsmonitor`, hooks). Never follows symlinks, skips only the root `.git` entry and does not
 * descend into a `.kiro` or a nested `.git` it has found.
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
      const lower = entry.name.toLowerCase();
      if (rel === "" && entry.name === ".git") continue;
      const entryRel = rel === "" ? entry.name : join(rel, entry.name);
      if (lower === ".git") {
        found.push(entryRel);
        continue;
      }
      if (CONFIG_NAMES.has(lower)) {
        found.push(entryRel);
        if (lower === ".kiro") continue;
      }
      if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(entryRel);
    }
  }

  return found.sort();
}
