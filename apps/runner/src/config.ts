import { execFile } from "node:child_process";
import { mkdir, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { isValidNick } from "@seance/irc-protocol";

const execFileAsync = promisify(execFile);

export type HarnessKind = "acp" | "headless";

export interface RunnerConfig {
  readonly harness: HarnessKind;
  readonly kiroBin: string;
  /** Carried only to be placed in a child environment; never log it. */
  readonly kiroApiKey: string | undefined;
  readonly targetRepo: string;
  readonly workspaces: string;
  readonly agentsDir: string;
  readonly promptTimeoutMs: number;
  /** Per-channel credit cap; undefined means no cap. */
  readonly channelCreditCap: number | undefined;
  readonly inviteRate: number;
  /**
   * Allowed inviter nicks; undefined means everyone, which `createRunner` accepts only while the
   * ircd binds to loopback.
   */
  readonly inviters: readonly string[] | undefined;
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

/** Thrown for an invalid or missing configuration value; names the variable. */
export class ConfigError extends Error {
  readonly variable: string;

  constructor(variable: string, message: string) {
    super(message);
    this.name = "ConfigError";
    this.variable = variable;
  }
}

const DEFAULT_PROMPT_TIMEOUT_MS = 120_000;
const DEFAULT_INVITE_RATE = 5;

function describe(raw: string): string {
  return JSON.stringify(raw);
}

function readString(env: EnvSource, name: string): string | undefined {
  const raw = env[name];
  return raw === undefined || raw === "" ? undefined : raw;
}

function requireNonEmpty(env: EnvSource, name: string, fallback?: string): string {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    if (fallback !== undefined) return fallback;
    throw new ConfigError(name, `${name} is required but is unset or empty`);
  }
  if (raw.trim() === "") {
    throw new ConfigError(name, `${name} must not be blank (got ${describe(raw)})`);
  }
  return raw;
}

function positiveInteger(env: EnvSource, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigError(name, `${name} must be a positive integer (got ${describe(raw)})`);
  }
  return value;
}

function parseHarness(env: EnvSource): HarnessKind {
  const raw = env["SEANCE_HARNESS"];
  if (raw === undefined || raw === "") return "acp";
  if (raw === "acp" || raw === "headless") return raw;
  throw new ConfigError(
    "SEANCE_HARNESS",
    `SEANCE_HARNESS must be "acp" or "headless" (got ${describe(raw)})`,
  );
}

function parseCreditCap(env: EnvSource): number | undefined {
  const raw = env["SEANCE_CHANNEL_CREDIT_CAP"];
  if (raw === undefined || raw === "") return undefined;
  const trimmed = raw.trim();
  const value = trimmed === "" ? Number.NaN : Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigError(
      "SEANCE_CHANNEL_CREDIT_CAP",
      `SEANCE_CHANNEL_CREDIT_CAP must be a finite number greater than 0 (got ${describe(raw)})`,
    );
  }
  return value;
}

function parseInviters(env: EnvSource): readonly string[] | undefined {
  const raw = env["SEANCE_INVITERS"];
  if (raw === undefined || raw.trim() === "") return undefined;
  const entries = raw.split(",").map((entry) => entry.trim());
  for (const entry of entries) {
    if (!isValidNick(entry)) {
      throw new ConfigError(
        "SEANCE_INVITERS",
        `SEANCE_INVITERS entry ${describe(entry)} is not a valid nick (got ${describe(raw)})`,
      );
    }
  }
  return entries;
}

/**
 * Pure: reads only `env` (and `cwd` for the default agents directory), no I/O.
 * Throws ConfigError naming the variable; never includes the KIRO_API_KEY value.
 */
export function loadRunnerConfig(env: EnvSource, cwd: string = process.cwd()): RunnerConfig {
  const harness = parseHarness(env);
  const kiroBin = requireNonEmpty(env, "SEANCE_KIRO_BIN", "kiro-cli");
  const targetRepo = requireNonEmpty(env, "SEANCE_TARGET_REPO");
  const workspaces = requireNonEmpty(env, "SEANCE_WORKSPACES");
  const agentsDirRaw = readString(env, "SEANCE_AGENTS_DIR");
  if (agentsDirRaw !== undefined && agentsDirRaw.trim() === "") {
    throw new ConfigError(
      "SEANCE_AGENTS_DIR",
      `SEANCE_AGENTS_DIR must not be blank (got ${describe(agentsDirRaw)})`,
    );
  }
  const agentsDir = agentsDirRaw ?? resolve(cwd, "agents");

  return {
    harness,
    kiroBin,
    kiroApiKey: readString(env, "KIRO_API_KEY"),
    targetRepo,
    workspaces,
    agentsDir,
    promptTimeoutMs: positiveInteger(env, "SEANCE_PROMPT_TIMEOUT_MS", DEFAULT_PROMPT_TIMEOUT_MS),
    channelCreditCap: parseCreditCap(env),
    inviteRate: positiveInteger(env, "SEANCE_INVITE_RATE", DEFAULT_INVITE_RATE),
    inviters: parseInviters(env),
  };
}

/** True for `localhost`, `::1`, `[::1]` and any `127.x.y.z`. An unset host (all interfaces) is not loopback. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (host === undefined) return false;
  const h = host.trim().toLowerCase();
  return h === "localhost" || h === "::1" || h === "[::1]" || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * Open invites (no SEANCE_INVITERS) let anyone who can reach the ircd start agents, so they are
 * allowed only when the ircd binds to loopback. Throws a ConfigError naming SEANCE_INVITERS.
 */
export function assertInvitersConfigured(config: RunnerConfig, bindHost: string | undefined): void {
  if (config.inviters !== undefined && config.inviters.length > 0) return;
  if (isLoopbackHost(bindHost)) return;
  throw new ConfigError(
    "SEANCE_INVITERS",
    `SEANCE_INVITERS is unset and the ircd is not bound to loopback (IRCD_HOST=${
      bindHost === undefined ? "(unset, all interfaces)" : describe(bindHost)
    }); set SEANCE_INVITERS to a comma-separated list of allowed inviter nicks, or bind IRCD_HOST to 127.0.0.1`,
  );
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Checks the filesystem side of the config before any worktree is created:
 * SEANCE_TARGET_REPO is a git repository, SEANCE_AGENTS_DIR exists, and
 * SEANCE_WORKSPACES is created if missing. Returns the config with the
 * workspaces path replaced by its realpath (the Worktree_Root).
 */
export async function validateRunnerPaths(config: RunnerConfig): Promise<RunnerConfig> {
  if (!(await isDirectory(config.targetRepo))) {
    throw new ConfigError(
      "SEANCE_TARGET_REPO",
      `SEANCE_TARGET_REPO is not a directory (got ${describe(config.targetRepo)})`,
    );
  }
  try {
    await execFileAsync("git", ["rev-parse", "--git-dir"], { cwd: config.targetRepo });
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new ConfigError(
      "SEANCE_TARGET_REPO",
      `SEANCE_TARGET_REPO is not a git repository (got ${describe(config.targetRepo)}): ${reason ?? "git failed"}`,
    );
  }
  if (!(await isDirectory(config.agentsDir))) {
    throw new ConfigError(
      "SEANCE_AGENTS_DIR",
      `SEANCE_AGENTS_DIR is not an existing directory (got ${describe(config.agentsDir)})`,
    );
  }
  try {
    await mkdir(config.workspaces, { recursive: true });
    const workspaces = await realpath(config.workspaces);
    return { ...config, workspaces };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(
      "SEANCE_WORKSPACES",
      `SEANCE_WORKSPACES could not be created (got ${describe(config.workspaces)}): ${reason}`,
    );
  }
}
