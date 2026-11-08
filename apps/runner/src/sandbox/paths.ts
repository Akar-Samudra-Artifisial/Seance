import { realpath } from "node:fs/promises";
import { sep } from "node:path";
import { SandboxError } from "./errors.js";

/** True when `inner` equals `outer` or lies below it (both absolute, normalised). */
export function isWithin(inner: string, outer: string): boolean {
  if (inner === outer) return true;
  const prefix = outer.endsWith(sep) ? outer : `${outer}${sep}`;
  return inner.startsWith(prefix);
}

const overlaps = (a: string, b: string): boolean => isWithin(a, b) || isWithin(b, a);

export type MountPaths = {
  readonly sessionCwd: string;
  readonly worktreeRoot: string;
  readonly agentsDir: string;
  readonly authDir: string;
  /** SEANCE_TARGET_REPO; must not be reachable through the session mount. */
  readonly targetRepo?: string;
};

/**
 * Pure containment rules of Requirement 5.3 and 5.4 on realpaths: the session directory lies strictly
 * inside the Worktree_Root, is not `/`, and overlaps neither the agents directory, the Auth_Dir nor
 * the target repository in either direction. Throws `SandboxError("invalid-input")`.
 */
export function assertMountPaths(p: MountPaths): void {
  const fail = (why: string): never => {
    throw new SandboxError("invalid-input", `sandbox mount refused: ${why}`);
  };
  if (p.sessionCwd === "/" || p.worktreeRoot === "/") fail("the filesystem root cannot be mounted");
  if (p.sessionCwd === p.worktreeRoot) fail("the session directory is the workspaces root itself");
  if (!isWithin(p.sessionCwd, p.worktreeRoot)) fail("the session directory is outside the workspaces root");
  if (overlaps(p.sessionCwd, p.agentsDir)) fail("the session directory overlaps the agents directory");
  if (overlaps(p.sessionCwd, p.authDir)) fail("the session directory overlaps the auth directory");
  if (overlaps(p.authDir, p.agentsDir)) fail("the auth directory overlaps the agents directory");
  if (p.targetRepo !== undefined && isWithin(p.targetRepo, p.sessionCwd)) {
    fail("the session directory contains the target repository");
  }
}

/** Realpaths the session directory, then applies `assertMountPaths`. */
export async function resolveMountPaths(p: MountPaths): Promise<MountPaths> {
  let sessionCwd: string;
  try {
    sessionCwd = await realpath(p.sessionCwd);
  } catch (err) {
    throw new SandboxError(
      "invalid-input",
      `sandbox mount refused: the session directory cannot be resolved (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const resolved: MountPaths = { ...p, sessionCwd };
  assertMountPaths(resolved);
  return resolved;
}
