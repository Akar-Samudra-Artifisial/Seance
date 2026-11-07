/**
 * Pure permission policy (Requirement 8). No I/O, no clock, deterministic, fail closed.
 * Path canonicalisation (the only I/O) lives in `canonicalise.ts`.
 */
import { posix } from "node:path";
import { matchDenyList } from "./deny-list.js";

export type PolicyMode = "op" | "voice" | "none";
export type ToolClass = "read" | "write" | "shell" | "unclassified";
export type ResolvedPath = { readonly raw: string; readonly resolved: string | undefined };
export type PolicyInput = {
  readonly mode: PolicyMode;
  readonly tool: {
    readonly kind: string;
    readonly paths: readonly ResolvedPath[];
    readonly command?: string;
  };
  /** Realpath of the Worktree (or of the private directory). */
  readonly worktree: string;
};
export type PermissionReason =
  | "no-mode"
  | "needs-op"
  | "outside-worktree"
  | "unclassified"
  | "unresolved-path"
  | "deny-list"
  | "protected-path"
  | "private-session";
export type PermissionResult =
  | { readonly decision: "allow_once" }
  | { readonly decision: "reject_once"; readonly reason: PermissionReason };

const KIND_CLASS: ReadonlyMap<string, ToolClass> = new Map<string, ToolClass>([
  ["read", "read"],
  ["search", "read"],
  ["edit", "write"],
  ["delete", "write"],
  ["move", "write"],
  ["execute", "shell"],
  ["fetch", "unclassified"],
  ["think", "unclassified"],
  ["other", "unclassified"],
]);

/** Classifies an ACP `toolCall.kind`; unknown strings are `unclassified`. */
export function classifyKind(kind: string): ToolClass {
  return KIND_CLASS.get(kind) ?? "unclassified";
}

const PROTECTED_DIR = ".kiro";
const PROTECTED_FILE = "agents.md";

/** True when the last meaningful segment is `AGENTS.md` or any segment is `.kiro` (any letter case). */
export function isProtectedPath(resolved: string): boolean {
  const segments = resolved.split(/[/\\]/).map((s) => s.toLowerCase());
  if (segments.includes(PROTECTED_DIR)) return true;
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i];
    if (segment === "" || segment === ".") continue;
    return segment === PROTECTED_FILE;
  }
  return false;
}

const reject = (reason: PermissionReason): PermissionResult => ({ decision: "reject_once", reason });
const ALLOW: PermissionResult = { decision: "allow_once" };

/** Strictly inside the worktree, lexically, on absolute paths only. */
function isInside(worktree: string, resolved: string, allowEqual: boolean): boolean {
  if (!posix.isAbsolute(worktree) || !posix.isAbsolute(resolved)) return false;
  const rel = posix.relative(worktree, resolved);
  if (rel === "") return allowEqual;
  return rel !== ".." && !rel.startsWith("../") && !posix.isAbsolute(rel);
}

function evaluate(input: PolicyInput): PermissionResult {
  const { mode, tool, worktree } = input;
  const toolClass = classifyKind(tool.kind);

  // 1. unclassified
  if (toolClass === "unclassified") return reject("unclassified");

  // 2. unresolved or empty paths
  const paths = tool.paths;
  if (toolClass !== "shell" && paths.length === 0) return reject("unresolved-path");
  const command = tool.command;
  if (toolClass === "shell" && (command === undefined || command.trim() === "")) {
    return reject("unresolved-path");
  }
  for (const p of paths) {
    if (p.raw.trim() === "" || p.raw.includes("\0")) return reject("unresolved-path");
    if (p.resolved === undefined || p.resolved === "" || p.resolved.includes("\0")) {
      return reject("unresolved-path");
    }
  }

  // 3. confinement, regardless of mode
  if (worktree === "") return reject("outside-worktree");
  const allowEqual = toolClass !== "write";
  for (const p of paths) {
    if (p.resolved === undefined || !isInside(worktree, p.resolved, allowEqual)) {
      return reject("outside-worktree");
    }
  }

  // 4. protected paths for writes, on the resolved and the raw path of every entry
  if (toolClass === "write") {
    for (const p of paths) {
      if (isProtectedPath(p.raw) || (p.resolved !== undefined && isProtectedPath(p.resolved))) {
        return reject("protected-path");
      }
    }
  }

  // 5. shell deny list (protected references first)
  if (toolClass === "shell" && command !== undefined) {
    const match = matchDenyList(command, worktree);
    if (match !== undefined) return reject(match.reason);
  }

  // 6. mode
  if (mode !== "op" && mode !== "voice") return reject("no-mode");

  // 7. read
  if (toolClass === "read") return ALLOW;

  // 8. write and shell only for op
  return mode === "op" ? ALLOW : reject("needs-op");
}

/** Pure decision for one tool call. Any internal failure rejects. */
export function decide(input: PolicyInput): PermissionResult {
  try {
    return evaluate(input);
  } catch {
    return reject("unclassified");
  }
}
