/**
 * Path canonicalisation for the permission policy (Requirement 8.5, 8.6).
 * The only I/O of the permissions module. Fails closed: anything that cannot be
 * resolved with certainty yields `resolved: undefined`, which `decide` rejects.
 */
import { lstat, realpath } from "node:fs/promises";
import { posix } from "node:path";
import type { ResolvedPath } from "./policy.js";

const isMissing = (err: unknown): boolean => {
  const code = (err as { readonly code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/**
 * `realpath` of the deepest existing ancestor of `absolute`, with the missing
 * tail appended. A dangling symlink is refused (a later write would follow it).
 * Throws on any other failure.
 */
async function realDeepest(absolute: string): Promise<string> {
  const tail: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      const real = await realpath(current);
      return tail.length === 0 ? real : posix.join(real, ...tail);
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
    // `current` does not resolve: refuse when it is itself a (dangling) symlink.
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error("dangling symlink");
      }
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
    const parent = posix.dirname(current);
    if (parent === current) throw new Error("no existing ancestor");
    tail.unshift(posix.basename(current));
    current = parent;
  }
}

/** Realpath of the worktree itself; `undefined` when it cannot be resolved. */
export async function realWorktree(worktree: string): Promise<string | undefined> {
  if (!posix.isAbsolute(worktree) || worktree.includes("\0")) return undefined;
  try {
    return await realpath(worktree);
  } catch {
    return undefined;
  }
}

async function resolveOne(raw: string, base: string): Promise<string | undefined> {
  if (raw.trim() === "" || raw.includes("\0")) return undefined;
  try {
    let current = posix.isAbsolute(raw) ? "/" : base;
    for (const segment of raw.split("/")) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") {
        // Resolve symlinks before climbing, as the kernel does.
        current = posix.dirname(await realDeepest(current));
      } else {
        current = posix.join(current, segment);
      }
    }
    return await realDeepest(current);
  } catch {
    return undefined;
  }
}

/**
 * Relative paths are joined to the (real) worktree; the deepest existing
 * ancestor is `realpath`ed and the remaining segments appended.
 */
export async function canonicalise(
  rawPaths: readonly string[],
  worktree: string,
): Promise<readonly ResolvedPath[]> {
  const base = await realWorktree(worktree);
  return Promise.all(
    rawPaths.map(async (raw): Promise<ResolvedPath> => {
      if (base === undefined) return { raw, resolved: undefined };
      return { raw, resolved: await resolveOne(raw, base) };
    }),
  );
}
