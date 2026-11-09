import { execFile } from "node:child_process";
import { allowListedEnv, type EnvLike } from "../child-env.js";

/** Result of a successful git invocation. */
export type GitResult = {
  readonly stdout: string;
  readonly stderr: string;
};

/** Thrown when git exits non-zero or cannot be started. */
export class GitError extends Error {
  readonly args: readonly string[];
  /** Exit code, or undefined when git could not be spawned or was killed by a signal. */
  readonly exitCode: number | undefined;
  readonly stderr: string;
  /** public-hardening Requirement 9.1: the call ran past its timeout and was killed. */
  readonly timedOut: boolean;

  constructor(args: readonly string[], exitCode: number | undefined, stderr: string, cause: string, timedOut = false) {
    super(`git ${args.join(" ")} failed: ${cause}${stderr === "" ? "" : `: ${stderr.trim()}`}`);
    this.name = "GitError";
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.timedOut = timedOut;
  }
}

/** Runs git commands for one repository; `locked` serialises mutating sequences. */
export interface GitRunner {
  /** Runs `git <args>` with an argument array (no shell). Rejects with GitError. */
  run(args: readonly string[]): Promise<GitResult>;
  /** Runs `fn` while holding the per-repository mutex. */
  locked<T>(fn: () => Promise<T>): Promise<T>;
}

const MAX_BUFFER = 16 * 1024 * 1024;
/** public-hardening Requirement 9.1: default per-call timeout (SEANCE_GIT_TIMEOUT_MS). */
export const DEFAULT_GIT_TIMEOUT_MS = 60_000;

/** Environment for git: allow-listed names only (never KIRO_API_KEY), no prompts, C locale. */
export function gitEnv(source: EnvLike): Record<string, string | undefined> {
  return { ...allowListedEnv(source), GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
}

/**
 * agent-sandbox Requirement 9.2: the hardened environment ignores the user's and the system's git
 * config, so only the repository's own config (host-owned) applies.
 */
export function hardenedGitEnv(source: EnvLike): Record<string, string | undefined> {
  return { ...gitEnv(source), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
}

/** Per-repo mutex tails, shared by every runner for the same repo path. */
const tails = new Map<string, Promise<void>>();

/**
 * Runs `git <args>` through `execFile` (never a shell), so channel names and
 * paths are passed as plain argv elements.
 */
export function runGit(
  args: readonly string[],
  env: Record<string, string | undefined> = gitEnv(process.env),
  timeoutMs: number = DEFAULT_GIT_TIMEOUT_MS,
): Promise<GitResult> {
  return new Promise<GitResult>((resolve, reject) => {
    execFile(
      "git",
      [...args],
      {
        encoding: "utf8",
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        env,
        // A hung git (a lock, a slow filesystem, a hostile hook) is killed, so the caller and the
        // per-repository mutex always settle.
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout, stderr });
          return;
        }
        const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
        const exitCode = typeof code === "number" ? code : undefined;
        const timedOut = (error as { killed?: boolean }).killed === true && exitCode === undefined;
        const cause = timedOut ? `timed out after ${timeoutMs} ms` : (error.message.split("\n")[0] ?? "unknown error");
        reject(new GitError(args, exitCode, stderr, cause, timedOut));
      },
    );
  });
}

/**
 * Creates a runner whose `locked` calls are serialised per `repo` path. `hardened` (podman mode)
 * adds the environment of `hardenedGitEnv`.
 */
export function createGitRunner(
  repo: string,
  opts: { readonly hardened?: boolean; readonly timeoutMs?: number } = {},
): GitRunner {
  const hardened = opts.hardened === true;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  return {
    run: (args) => runGit(args, hardened ? hardenedGitEnv(process.env) : gitEnv(process.env), timeoutMs),
    locked<T>(fn: () => Promise<T>): Promise<T> {
      const previous = tails.get(repo) ?? Promise.resolve();
      const result = previous.then(fn);
      const tail = result.then(
        () => undefined,
        () => undefined,
      );
      tails.set(repo, tail);
      void tail.then(() => {
        if (tails.get(repo) === tail) tails.delete(repo);
      });
      return result;
    },
  };
}
