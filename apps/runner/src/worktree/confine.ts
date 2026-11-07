import { realpath } from "node:fs/promises";
import { relative, isAbsolute } from "node:path";

/** Thrown when a worktree path is not strictly inside the workspaces root. */
export class WorktreeConfinementError extends Error {
  readonly channel: string;
  readonly root: string;
  readonly path: string;

  constructor(channel: string, root: string, path: string, reason: string) {
    super(`worktree for channel ${channel} rejected: ${reason} (root ${root}, path ${path})`);
    this.name = "WorktreeConfinementError";
    this.channel = channel;
    this.root = root;
    this.path = path;
  }
}

/**
 * Resolves `path` with realpath and requires it to be strictly inside the
 * realpath of `root`. Equal to the root or outside it throws
 * WorktreeConfinementError naming `channel`. Returns the resolved path.
 */
export async function resolveInside(root: string, path: string, channel: string): Promise<string> {
  let realRoot: string;
  let realPath: string;
  try {
    realRoot = await realpath(root);
    realPath = await realpath(path);
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new WorktreeConfinementError(channel, root, path, `cannot resolve path: ${cause}`);
  }

  const rel = relative(realRoot, realPath);
  if (rel === "") {
    throw new WorktreeConfinementError(channel, root, path, "path equals the workspaces root");
  }
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new WorktreeConfinementError(channel, root, path, "path resolves outside the workspaces root");
  }
  return realPath;
}
