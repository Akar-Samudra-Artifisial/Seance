import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join } from "node:path";
import { irc_lower } from "@seance/irc-protocol";
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
  | "private-dir"
  | "commit";

/** A git or filesystem step failed for a channel's worktree. */
export class WorktreeError extends Error {
  readonly channel: string;
  readonly operation: WorktreeOperation;
  readonly detail: string;
  /** public-hardening Requirement 9.1: the failing git call was killed by its timeout. */
  readonly timedOut: boolean;

  constructor(channel: string, operation: WorktreeOperation, detail: string, timedOut = false) {
    super(`worktree ${operation} failed for channel ${channel}: ${detail}`);
    this.name = "WorktreeError";
    this.channel = channel;
    this.operation = operation;
    this.detail = detail;
    this.timedOut = timedOut;
  }
}

export type WorktreeInfo = {
  readonly path: string;
  readonly realPath: string;
  readonly branch: string;
  readonly created: boolean;
};

/** What a reset did: the commit it moved to and how many Dirty_Files it reverted. */
export type ResetReport = {
  /** Seven-character sha of the worktree `HEAD` after the reset. */
  readonly target: string;
  /** Records of `git status --porcelain=v1 -z --untracked-files=all --no-renames` before the reset. */
  readonly filesReverted: number;
};

export type GuardResult = { readonly ok: true } | { readonly ok: false; readonly paths: readonly string[] };

/** Outcome of a host-side commit after an agent turn (agent-sandbox Requirement 14). */
export type TurnCommitResult =
  | { readonly kind: "committed"; readonly sha: string; readonly files: number }
  | { readonly kind: "clean" }
  | { readonly kind: "refused"; readonly paths: readonly string[] }
  /** public-hardening Requirement 9: too large or git timed out; the worktree was reset to HEAD. */
  | { readonly kind: "reset"; readonly reason: string };

/**
 * True when the files below `dir` (not `.git`, symlinks not followed) add up to more than
 * `max` bytes. Stops as soon as the limit is passed.
 */
export async function exceedsBytes(dir: string, max: number): Promise<boolean> {
  let total = 0;
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (current === dir && entry.name === ".git") continue;
      const abs = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile()) {
        total += (await lstat(abs)).size;
        if (total > max) return true;
      }
    }
  }
  return false;
}

export type WorktreeManagerOptions = {
  readonly repo: string;
  readonly root: string;
  readonly git: GitRunner;
  /**
   * agent-sandbox Requirement 9 (podman mode): the worktree is writable from a container, so every
   * git call on it passes `--git-dir` (recorded from the repository side) and `--work-tree`, and the
   * `.git` file is verified before each prompt. Default false: calls stay `git -C <worktree> ...`.
   */
  readonly hardened?: boolean;
  /** public-hardening Requirement 9.2: `commitTurn` resets instead of committing above this size. */
  readonly maxBytes?: number;
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

/**
 * agent-sandbox review finding 1: config overrides on every hardened host git call on a worktree,
 * so an fsmonitor, an untracked cache or a submodule recursion set in agent-writable files is never
 * honoured. They come before `--git-dir` and beat any repository setting.
 */
export const HARDENED_GIT_CONFIG: readonly string[] = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "submodule.recurse=false",
];

/** `git status` flag that keeps submodules out of the host's view (`git add` has no such option). */
export const IGNORE_SUBMODULES = "--ignore-submodules=all";

/** Committer of host-side commits (Requirement 14.2). */
export const RUNNER_COMMITTER = { name: "Séance runner", email: "runner@seance.invalid" } as const;

/** Author e-mail local part: `irc_lower` nick, every character outside `[a-z0-9._-]` becomes `-`. */
export function authorKey(nick: string): string {
  const key = irc_lower(nick).replace(/[^a-z0-9._-]/g, "-");
  return key === "" ? "agent" : key;
}

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

async function realOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

export class WorktreeManager {
  readonly #repo: string;
  readonly #root: string;
  readonly #git: GitRunner;
  readonly #hardened: boolean;
  readonly #maxBytes: number | undefined;
  readonly #ensuring = new Map<string, Promise<WorktreeInfo>>();
  /** Requirement 9.1: realpath of the worktree -> its git dir, read from the repository side. */
  readonly #gitDirs = new Map<string, string>();

  constructor(opts: WorktreeManagerOptions) {
    this.#repo = opts.repo;
    this.#root = opts.root;
    this.#git = opts.git;
    this.#hardened = opts.hardened === true;
    this.#maxBytes = opts.maxBytes;
  }

  /** Creates or reuses the channel's worktree; confined and free of agent config. */
  ensure(channel: string): Promise<WorktreeInfo> {
    // Single-flight per worktree: two agents invited to one channel at once share one creation
    // instead of racing on `git worktree add` ("already exists").
    const key = sanitizeChannel(channel);
    const running = this.#ensuring.get(key);
    if (running !== undefined) return running;
    const attempt = this.#ensureOnce(channel).finally(() => {
      if (this.#ensuring.get(key) === attempt) this.#ensuring.delete(key);
    });
    this.#ensuring.set(key, attempt);
    return attempt;
  }

  async #ensureOnce(channel: string): Promise<WorktreeInfo> {
    const name = sanitizeChannel(channel);
    const path = join(this.#root, name);
    const branch = `seance/${name}`;
    let created = false;

    if (await this.#safeExists(channel, path)) {
      const realPath = await resolveInside(this.#root, path, channel);
      if (this.#hardened) {
        // First reuse after a restart: record the git dir and repair `.git` before any git call.
        await this.#gitDirOf(channel, realPath);
        await this.#restoreDotGit(channel, realPath);
      }
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

  /**
   * Discards uncommitted and untracked files; keeps the branch. Reports what it did
   * (runner-services Req 6.2, 6.3): the short sha the worktree now points at, and the number of
   * Dirty_Files counted just before the reset.
   */
  async reset(channel: string, opts: { readonly ignored?: boolean } = {}): Promise<ResetReport> {
    const path = join(this.#root, sanitizeChannel(channel));
    const realPath = await resolveInside(this.#root, path, channel);
    if ((await this.#toplevel(channel, realPath)) !== realPath) {
      throw new WorktreeError(channel, "reset", `${path} is not the toplevel of a git worktree`);
    }
    // Commits that touch AGENTS.md or .kiro are discarded: the branch goes back to its base.
    const target = (await this.#committedHits(channel, realPath)).length > 0 ? await this.#base(channel, realPath) : "HEAD";
    const wt = await this.#prefix(channel, realPath);
    return this.#git.locked(async () => {
      try {
        const status = await this.#git.run([
          ...wt,
          "status",
          ...this.#statusExtra(),
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--no-renames",
        ]);
        const filesReverted = status.stdout.split("\0").filter((r) => r !== "").length;
        await this.#git.run([...wt, "reset", "--hard", target]);
        // public-hardening Requirement 14.2: after an oversize turn ignored files go too, or a
        // gitignored blob would survive every reset.
        await this.#git.run([...wt, "clean", opts.ignored === true ? "-fdx" : "-fd"]);
        const short = (await this.#git.run([...wt, "rev-parse", "--short=7", "HEAD"])).stdout.trim();
        return { target: short, filesReverted };
      } catch (err) {
        throw new WorktreeError(channel, "reset", message(err));
      }
    });
  }

  /** Seven-character sha of the worktree `HEAD`; undefined when it cannot be read (Req 5.3). */
  async shortHead(channel: string): Promise<string | undefined> {
    try {
      const path = join(this.#root, sanitizeChannel(channel));
      const realPath = await resolveInside(this.#root, path, channel);
      const wt = await this.#prefix(channel, realPath);
      const sha = (await this.#git.run([...wt, "rev-parse", "--short=7", "HEAD"])).stdout.trim();
      return /^[0-9a-f]{7,40}$/.test(sha) ? sha : undefined;
    } catch {
      return undefined;
    }
  }

  /** Scans before a prompt; on a hit resets, removes the entries and reports them. */
  async guardBeforePrompt(channel: string): Promise<GuardResult> {
    const path = join(this.#root, sanitizeChannel(channel));
    const realPath = await resolveInside(this.#root, path, channel);
    if (this.#hardened && (await this.#restoreDotGit(channel, realPath))) {
      // Requirement 9.3, design D15: report through the existing guard result after the repair.
      await this.reset(channel);
      return { ok: false, paths: [".git"] };
    }
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

  /**
   * agent-sandbox Requirement 14: commits every change in the channel's worktree on the host,
   * authored by `agent`, with hooks, signing and the user's config off. Protected config present
   * means no commit (`refused`); no change means no commit (`clean`).
   */
  async commitTurn(channel: string, agent: string): Promise<TurnCommitResult> {
    const path = join(this.#root, sanitizeChannel(channel));
    const realPath = await resolveInside(this.#root, path, channel);
    if (this.#hardened && (await this.#restoreDotGit(channel, realPath))) {
      // A rewritten `.git` means the turn's work cannot be trusted: discard it, as the guard does.
      await this.reset(channel);
      return { kind: "refused", paths: [".git"] };
    }
    const hits = await scanConfig(realPath);
    if (hits.length > 0) return { kind: "refused", paths: hits };
    // public-hardening Requirement 9.2: an oversized worktree is never committed (a disk-filling
    // turn); its work is discarded instead.
    if (this.#maxBytes !== undefined && (await exceedsBytes(realPath, this.#maxBytes))) {
      await this.reset(channel, { ignored: true });
      return { kind: "reset", reason: `the worktree is larger than ${this.#maxBytes} bytes` };
    }
    let result: TurnCommitResult;
    try {
      result = await this.#commitLocked(channel, agent, realPath);
    } catch (err) {
      // Requirement 9.1: a hung git was killed and the mutex released; the turn's work is
      // discarded so the next turn starts from a known state.
      if (!(err instanceof WorktreeError && err.timedOut)) throw err;
      await this.reset(channel, { ignored: true });
      return { kind: "reset", reason: "git timed out" };
    }
    return result;
  }

  /**
   * public-hardening Requirement 14.1: true when the channel's worktree is above `maxBytes`
   * (always false without a cap). Checked after each completed tool call of a turn.
   */
  async exceedsCap(channel: string): Promise<boolean> {
    if (this.#maxBytes === undefined) return false;
    const realPath = await resolveInside(this.#root, join(this.#root, sanitizeChannel(channel)), channel);
    return exceedsBytes(realPath, this.#maxBytes);
  }

  /** The cap in bytes, for messages; undefined without one. */
  get maxBytes(): number | undefined {
    return this.#maxBytes;
  }

  async #commitLocked(channel: string, agent: string, realPath: string): Promise<TurnCommitResult> {
    const wt = await this.#prefix(channel, realPath);
    return this.#git.locked(async () => {
      try {
        const status = await this.#git.run([
          ...wt,
          "status",
          ...this.#statusExtra(),
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--no-renames",
        ]);
        const files = status.stdout.split("\0").filter((r) => r !== "").length;
        if (files === 0) return { kind: "clean" };
        await this.#git.run([...wt, "add", "--all", "--", "."]);
        await this.#git.run([
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "commit.gpgSign=false",
          "-c",
          `user.name=${RUNNER_COMMITTER.name}`,
          "-c",
          `user.email=${RUNNER_COMMITTER.email}`,
          ...wt,
          "commit",
          "--no-verify",
          "--quiet",
          `--author=${agent} <${authorKey(agent)}@seance.invalid>`,
          "-m",
          `${agent}: turn in ${channel}`,
        ]);
        const sha = (await this.#git.run([...wt, "rev-parse", "--short=7", "HEAD"])).stdout.trim();
        return { kind: "committed", sha, files };
      } catch (err) {
        throw new WorktreeError(channel, "commit", message(err), err instanceof GitError && err.timedOut);
      }
    });
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

  #statusExtra(): readonly string[] {
    return this.#hardened ? [IGNORE_SUBMODULES] : [];
  }

  /**
   * The argv prefix of a git call on the worktree. Not hardened: `-C <worktree>` (unchanged).
   * Hardened (Requirement 9.2): `--git-dir=<recorded>` and `--work-tree=<worktree>`, so the
   * agent-writable `.git` file is never read.
   */
  async #prefix(channel: string, realPath: string): Promise<readonly string[]> {
    if (!this.#hardened) return ["-C", realPath];
    const gitDir = await this.#gitDirOf(channel, realPath);
    return [...HARDENED_GIT_CONFIG, `--git-dir=${gitDir}`, `--work-tree=${realPath}`];
  }

  /**
   * Requirement 9.1: the worktree's git dir, from the repository side only. The worktree must be
   * listed by `git -C <repo> worktree list --porcelain`; its admin directory is found by the
   * `gitdir` files under `<common dir>/worktrees/` (host-owned), never by the `.git` file.
   */
  async #gitDirOf(channel: string, realPath: string): Promise<string> {
    const known = this.#gitDirs.get(realPath);
    if (known !== undefined) return known;
    try {
      const list = await this.#git.run(["-C", this.#repo, "worktree", "list", "--porcelain"]);
      const listed = list.stdout
        .split("\n")
        .filter((l) => l.startsWith("worktree "))
        .map((l) => l.slice("worktree ".length));
      const resolved = await Promise.all(listed.map((p) => realOrSelf(p)));
      if (!resolved.includes(realPath)) throw new Error(`${realPath} is not a registered worktree of ${this.#repo}`);
      const common = (await this.#git.run(["-C", this.#repo, "rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
      const adminRoot = join(await realOrSelf(common), "worktrees");
      for (const name of await readdir(adminRoot)) {
        let target: string;
        try {
          target = (await readFile(join(adminRoot, name, "gitdir"), "utf8")).trim();
        } catch {
          continue;
        }
        if (!isAbsolute(target)) continue;
        if ((await realOrSelf(dirname(target))) !== realPath) continue;
        const gitDir = join(adminRoot, name);
        this.#gitDirs.set(realPath, gitDir);
        return gitDir;
      }
      throw new Error(`no admin directory under ${adminRoot} points at ${realPath}`);
    } catch (err) {
      throw new WorktreeError(channel, "inspect", `cannot record the git dir: ${message(err)}`);
    }
  }

  /**
   * Requirement 9.3, 9.4: the worktree's `.git` must be a regular file holding `gitdir: <recorded>`.
   * Anything else (other content, a directory, a symlink) is replaced through a temp file and a
   * rename, which never follows a symlink. Returns true when it had to repair.
   */
  async #restoreDotGit(channel: string, realPath: string): Promise<boolean> {
    const gitDir = await this.#gitDirOf(channel, realPath);
    const dotGit = join(realPath, ".git");
    let ok = false;
    try {
      const st = await lstat(dotGit);
      if (st.isFile()) {
        const text = (await readFile(dotGit, "utf8")).trim();
        const m = /^gitdir: (.+)$/.exec(text);
        ok = m !== null && (m[1] === gitDir || (await realOrSelf(m[1] ?? "")) === gitDir);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new WorktreeError(channel, "inspect", `cannot read .git: ${message(err)}`);
      }
    }
    if (ok) return false;
    try {
      const st = await lstat(dotGit).catch(() => undefined);
      if (st?.isDirectory() === true) await rm(dotGit, { recursive: true, force: true });
      const tmp = join(realPath, `.git.seance-${randomBytes(4).toString("hex")}`);
      await writeFile(tmp, `gitdir: ${gitDir}\n`, { flag: "wx", mode: 0o644 });
      await rename(tmp, dotGit);
    } catch (err) {
      throw new WorktreeError(channel, "inspect", `cannot restore .git: ${message(err)}`);
    }
    return true;
  }

  async #sparse(channel: string, realPath: string): Promise<void> {
    try {
      const wt = await this.#prefix(channel, realPath);
      await this.#git.run([...wt, "sparse-checkout", "set", "--no-cone", ...SPARSE_PATTERNS]);
    } catch (err) {
      throw new WorktreeError(channel, "sparse-checkout", message(err));
    }
  }

  /** The commit the channel branch started from: the stored base, else the merge-base with the repo HEAD. */
  async #base(channel: string, realPath: string): Promise<string> {
    const wt = await this.#prefix(channel, realPath);
    try {
      const { stdout } = await this.#git.run([...wt, "config", "--worktree", "--get", BASE_CONFIG_KEY]);
      const stored = stdout.trim();
      if (stored !== "") return stored;
    } catch (err) {
      if (!(err instanceof GitError && err.exitCode === 1)) throw new WorktreeError(channel, "inspect", message(err));
    }
    try {
      const head = (await this.#git.run(["-C", this.#repo, "rev-parse", "HEAD"])).stdout.trim();
      const { stdout } = await this.#git.run([...wt, "merge-base", "HEAD", head]);
      return stdout.trim();
    } catch (err) {
      throw new WorktreeError(channel, "inspect", `cannot determine the base commit: ${message(err)}`);
    }
  }

  /** Protected paths touched by `git diff --name-only <base>..HEAD`. */
  async #committedHits(channel: string, realPath: string): Promise<readonly string[]> {
    const base = await this.#base(channel, realPath);
    const wt = await this.#prefix(channel, realPath);
    try {
      const { stdout } = await this.#git.run([...wt, "diff", "--name-only", "--no-renames", "-z", `${base}..HEAD`]);
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
      const wt = await this.#prefix(channel, realPath);
      const { stdout } = await this.#git.run([...wt, "rev-parse", "--show-toplevel"]);
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
        const wt = await this.#prefix(channel, realPath);
        const head = (await this.#git.run([...wt, "rev-parse", "HEAD"])).stdout.trim();
        await this.#git.run([...wt, "config", "--worktree", BASE_CONFIG_KEY, head]);
      } catch (err) {
        throw new WorktreeError(channel, "worktree-config", message(err));
      }
    }
  }
}
