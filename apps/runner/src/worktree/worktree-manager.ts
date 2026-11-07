import { mkdir, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { resolveInside } from "./confine.js";
import { GitError, type GitRunner } from "./git.js";
import { sanitizeChannel } from "./sanitize.js";
import { scanConfig } from "./scan-config.js";

/** Operation names used in WorktreeError. */
export type WorktreeOperation =
  | "worktree-add"
  | "worktree-config"
  | "sparse-checkout"
  | "reset"
  | "inspect"
  | "config-exclusion"
  | "private-dir";

/** A git or filesystem step failed for a channel's worktree. */
export class WorktreeError extends Error {
  readonly channel: string;
  readonly operation: WorktreeOperation;
  readonly detail: string;

  constructor(channel: string, operation: WorktreeOperation, detail: string) {
    super(`worktree ${operation} failed for channel ${channel}: ${detail}`);
    this.name = "WorktreeError";
    this.channel = channel;
    this.operation = operation;
    this.detail = detail;
  }
}

export type WorktreeInfo = {
  readonly path: string;
  readonly realPath: string;
  readonly branch: string;
  readonly created: boolean;
};

export type GuardResult = { readonly ok: true } | { readonly ok: false; readonly paths: readonly string[] };

export type WorktreeManagerOptions = {
  readonly repo: string;
  readonly root: string;
  readonly git: GitRunner;
};

/** Case-insensitive gitignore-style globs: sparse-checkout patterns are case-sensitive. */
const AGENTS_MD_CI = "[Aa][Gg][Ee][Nn][Tt][Ss].md";
const DOT_KIRO_CI = ".[Kk][Ii][Rr][Oo]";

export const SPARSE_PATTERNS: readonly string[] = [
  "/*",
  `!${AGENTS_MD_CI}`,
  `!${DOT_KIRO_CI}/`,
  `!**/${AGENTS_MD_CI}`,
  `!**/${DOT_KIRO_CI}/`,
];

const BASE_CONFIG_KEY = "seance.base";

/** Paths (from `git diff --name-only -z`) with a segment named AGENTS.md or .kiro, case-insensitive. */
export function protectedPaths(namesZ: string): readonly string[] {
  return namesZ
    .split("\0")
    .filter((p) => p !== "")
    .filter((p) =>
      p.split("/").some((seg) => {
        const lower = seg.toLowerCase();
        return lower === "agents.md" || lower === ".kiro";
      }),
    )
    .sort();
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export class WorktreeManager {
  readonly #repo: string;
  readonly #root: string;
  readonly #git: GitRunner;

  constructor(opts: WorktreeManagerOptions) {
    this.#repo = opts.repo;
    this.#root = opts.root;
    this.#git = opts.git;
  }

  /** Creates or reuses the channel's worktree; confined and free of agent config. */
  async ensure(channel: string): Promise<WorktreeInfo> {
    const name = sanitizeChannel(channel);
    const path = join(this.#root, name);
    const branch = `seance/${name}`;
    let created = false;

    if (await this.#safeExists(channel, path)) {
      const realPath = await resolveInside(this.#root, path, channel);
      if ((await this.#toplevel(channel, realPath)) !== realPath) {
        throw new WorktreeError(channel, "inspect", `${path} exists but is not a git worktree root`);
      }
      // Idempotent: a worktree made by an older version may lack the case-insensitive patterns.
      await this.#git.locked(async () => {
        await this.#sparse(channel, realPath);
      });
      const committed = await this.#committedHits(channel, realPath);
      if (committed.length > 0) {
        await this.reset(channel);
        throw new WorktreeError(channel, "config-exclusion", `committed: ${committed.join(", ")}`);
      }
    } else {
      await this.#git.locked(async () => {
        await this.#create(channel, path, branch);
      });
      created = true;
    }

    const realPath = await resolveInside(this.#root, path, channel);
    const hits = await scanConfig(realPath);
    if (hits.length > 0) throw new WorktreeError(channel, "config-exclusion", hits.join(", "));
    return { path, realPath, branch, created };
  }

  /** Discards uncommitted and untracked files; keeps the branch. */
  async reset(channel: string): Promise<void> {
    const path = join(this.#root, sanitizeChannel(channel));
    const realPath = await resolveInside(this.#root, path, channel);
    if ((await this.#toplevel(channel, realPath)) !== realPath) {
      throw new WorktreeError(channel, "reset", `${path} is not the toplevel of a git worktree`);
    }
    // Commits that touch AGENTS.md or .kiro are discarded: the branch goes back to its base.
    const target = (await this.#committedHits(channel, realPath)).length > 0 ? await this.#base(channel, realPath) : "HEAD";
    await this.#git.locked(async () => {
      try {
        await this.#git.run(["-C", realPath, "reset", "--hard", target]);
        await this.#git.run(["-C", realPath, "clean", "-fd"]);
      } catch (err) {
        throw new WorktreeError(channel, "reset", message(err));
      }
    });
  }

  /** Scans before a prompt; on a hit resets, removes the entries and reports them. */
  async guardBeforePrompt(channel: string): Promise<GuardResult> {
    const path = join(this.#root, sanitizeChannel(channel));
    const realPath = await resolveInside(this.#root, path, channel);
    const scanned = await scanConfig(realPath);
    const committed = await this.#committedHits(channel, realPath);
    const hits = [...new Set([...scanned, ...committed])].sort();
    if (hits.length === 0) return { ok: true };

    await this.reset(channel);
    for (const rel of scanned) {
      const abs = join(realPath, rel);
      // Confine the parent by realpath; the entry itself is removed without following it.
      let parent: string;
      try {
        parent = await realpath(dirname(abs));
      } catch (err) {
        // The reset's `clean` may already have removed the entry and its parents.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new WorktreeError(channel, "config-exclusion", `cannot resolve ${rel}: ${message(err)}`);
      }
      if (parent !== realPath && !parent.startsWith(`${realPath}/`)) {
        throw new WorktreeError(channel, "config-exclusion", `${rel} resolves outside the worktree`);
      }
      try {
        await rm(join(parent, basename(abs)), { recursive: true, force: true });
      } catch (err) {
        throw new WorktreeError(channel, "config-exclusion", `cannot remove ${rel}: ${message(err)}`);
      }
    }

    const remaining = await scanConfig(realPath);
    if (remaining.length > 0) throw new WorktreeError(channel, "config-exclusion", remaining.join(", "));
    return { ok: false, paths: hits };
  }

  /** Plain private directory for an agent: `<root>/_private/<sanitized nick>`. */
  async privateDir(agentNick: string): Promise<string> {
    const path = join(this.#root, "_private", sanitizeChannel(agentNick));
    try {
      await mkdir(path, { recursive: true });
    } catch (err) {
      throw new WorktreeError(agentNick, "private-dir", message(err));
    }
    return resolveInside(this.#root, path, agentNick);
  }

  async #sparse(channel: string, realPath: string): Promise<void> {
    try {
      await this.#git.run(["-C", realPath, "sparse-checkout", "set", "--no-cone", ...SPARSE_PATTERNS]);
    } catch (err) {
      throw new WorktreeError(channel, "sparse-checkout", message(err));
    }
  }

  /** The commit the channel branch started from: the stored base, else the merge-base with the repo HEAD. */
  async #base(channel: string, realPath: string): Promise<string> {
    try {
      const { stdout } = await this.#git.run(["-C", realPath, "config", "--worktree", "--get", BASE_CONFIG_KEY]);
      const stored = stdout.trim();
      if (stored !== "") return stored;
    } catch (err) {
      if (!(err instanceof GitError && err.exitCode === 1)) throw new WorktreeError(channel, "inspect", message(err));
    }
    try {
      const head = (await this.#git.run(["-C", this.#repo, "rev-parse", "HEAD"])).stdout.trim();
      const { stdout } = await this.#git.run(["-C", realPath, "merge-base", "HEAD", head]);
      return stdout.trim();
    } catch (err) {
      throw new WorktreeError(channel, "inspect", `cannot determine the base commit: ${message(err)}`);
    }
  }

  /** Protected paths touched by `git diff --name-only <base>..HEAD`. */
  async #committedHits(channel: string, realPath: string): Promise<readonly string[]> {
    const base = await this.#base(channel, realPath);
    try {
      const { stdout } = await this.#git.run([
        "-C",
        realPath,
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        `${base}..HEAD`,
      ]);
      return protectedPaths(stdout);
    } catch (err) {
      throw new WorktreeError(channel, "inspect", message(err));
    }
  }

  async #safeExists(channel: string, path: string): Promise<boolean> {
    try {
      return await exists(path);
    } catch (err) {
      throw new WorktreeError(channel, "inspect", message(err));
    }
  }

  async #toplevel(channel: string, realPath: string): Promise<string> {
    try {
      const { stdout } = await this.#git.run(["-C", realPath, "rev-parse", "--show-toplevel"]);
      return await realpath(stdout.trim());
    } catch (err) {
      throw new WorktreeError(channel, "inspect", message(err));
    }
  }

  async #branchExists(channel: string, branch: string): Promise<boolean> {
    try {
      await this.#git.run(["-C", this.#repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
      return true;
    } catch (err) {
      if (err instanceof GitError && err.exitCode === 1) return false;
      throw new WorktreeError(channel, "worktree-add", message(err));
    }
  }

  async #create(channel: string, path: string, branch: string): Promise<void> {
    try {
      await mkdir(this.#root, { recursive: true });
    } catch (err) {
      throw new WorktreeError(channel, "worktree-add", message(err));
    }
    const branchExisted = await this.#branchExists(channel, branch);
    const args = branchExisted
      ? ["-C", this.#repo, "worktree", "add", "--", path, branch]
      : ["-C", this.#repo, "worktree", "add", "-b", branch, "--", path, "HEAD"];
    try {
      await this.#git.run(args);
    } catch (err) {
      throw new WorktreeError(channel, "worktree-add", message(err));
    }

    try {
      await this.#git.run(["-C", this.#repo, "config", "extensions.worktreeConfig", "true"]);
    } catch (err) {
      throw new WorktreeError(channel, "worktree-config", message(err));
    }
    const realPath = await resolveInside(this.#root, path, channel);
    await this.#sparse(channel, realPath);
    if (!branchExisted) {
      try {
        const head = (await this.#git.run(["-C", realPath, "rev-parse", "HEAD"])).stdout.trim();
        await this.#git.run(["-C", realPath, "config", "--worktree", BASE_CONFIG_KEY, head]);
      } catch (err) {
        throw new WorktreeError(channel, "worktree-config", message(err));
      }
    }
  }
}
