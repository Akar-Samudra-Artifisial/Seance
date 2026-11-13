import { execFile } from "node:child_process";
import { mkdir, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { isValidNick } from "@seance/irc-protocol";
import { isCidr } from "./sandbox/cidr.js";
import { isSandboxKiroBin } from "./sandbox/kiro-bin.js";

const execFileAsync = promisify(execFile);

export type HarnessKind = "acp" | "headless";

/** `SEANCE_SANDBOX` (agent-sandbox Requirement 1.1). */
export type SandboxMode = "none" | "podman";

export interface PodmanSandboxConfig {
  readonly mode: "podman";
  readonly podmanBin: string;
  /** `name@sha256:<64 hex>` (Requirement 1.8, design D20). */
  readonly image: string;
  /**
   * Kiro login state, mounted read-only; optional when KIRO_API_KEY is set, required otherwise.
   * Realpath after `validateRunnerPaths`.
   */
  readonly authDir: string | undefined;
  readonly memory: string;
  readonly cpus: string;
  readonly pids: number;
  readonly timeoutS: number;
  /** Command name inside the image. */
  readonly kiroBin: string;
  /** `ip:port` targets the Probe must not reach, in every podman start (Requirement 7.7, review finding 4). */
  readonly egressProbes: readonly string[];
  /**
   * IPv4 CIDRs the host rule blocks (the VPC, other private ranges). The Probe tries one address
   * inside each and fails the start when it is reachable (`SEANCE_SANDBOX_BLOCKED_CIDRS`).
   */
  readonly blockedCidrs: readonly string[];
  /** Variables that were set but are ignored in podman mode; the runner logs each once. */
  readonly ignored: readonly "SEANCE_KIRO_BIN"[];
}

export type SandboxConfig = { readonly mode: "none" } | PodmanSandboxConfig;

export interface RunnerConfig {
  readonly harness: HarnessKind;
  readonly kiroBin: string;
  /** Carried only to be placed in a child environment; never log it. */
  readonly kiroApiKey: string | undefined;
  readonly targetRepo: string;
  readonly workspaces: string;
  readonly agentsDir: string;
  readonly promptTimeoutMs: number;
  /**
   * agent-runner Requirement 9.18: seconds without activity before an idle session is exorcised
   * (`SEANCE_IDLE_TIMEOUT_S`, 60 to 86400, default 900, both sandbox modes). Absent means 900.
   */
  readonly idleTimeoutS?: number;
  /** Per-channel credit cap; undefined means no cap. */
  readonly channelCreditCap: number | undefined;
  readonly inviteRate: number;
  /**
   * Allowed inviter nicks; undefined means everyone, which `createRunner` accepts only while the
   * ircd binds to loopback.
   */
  readonly inviters: readonly string[] | undefined;
  /** Agent sandbox (agent-sandbox Requirement 1); `{ mode: "none" }` unless SEANCE_SANDBOX=podman. */
  readonly sandbox: SandboxConfig;
  /** public-hardening Requirement 5.2: credits per UTC day for all agents; absent means no cap. */
  readonly dailyCreditCap?: number;
  /** Requirement 5.3: while this file exists no new turn starts; default `<workspaces>/.seance-paused`. */
  readonly killSwitchFile?: string;
  /** Requirement 5.5: channels with an open agent Session (default 2). */
  readonly maxAgentChannels?: number;
  /** Requirement 5.5: open agent sessions, channel and private (default 6). */
  readonly maxContainers?: number;
  /** Requirement 9.1: timeout per host git call (default 60000). */
  readonly gitTimeoutMs?: number;
  /** Requirement 9.2: worktree size before a host commit (default 500 MiB). */
  readonly worktreeMaxBytes?: number;
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

/** A comma would inject `--mount` options; quotes, NUL, CR and LF have no business in a path. */
const UNSAFE_CHARS = /[,"\0\r\n]/;

/** Requirement 1.5: rejects a value that cannot travel safely inside a `--mount` CSV value. */
function assertMountSafe(name: string, value: string): void {
  if (UNSAFE_CHARS.test(value)) {
    throw new ConfigError(
      name,
      `${name} must not contain a comma, a double quote, NUL, CR or LF in podman mode (got ${describe(value)})`,
    );
  }
}

const IMAGE_DIGEST = /^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$/;
const MEMORY = /^[1-9][0-9]*[kmg]$/i;
const CPUS = /^[0-9]+(?:\.[0-9]+)?$/;
const INTEGER = /^[0-9]+$/;
const PROBE_TARGET = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/;
const MAX_EGRESS_PROBES = 8;

/** Default of `SEANCE_IDLE_TIMEOUT_S` (agent-runner Requirement 9.18). */
export const DEFAULT_IDLE_TIMEOUT_S = 900;

/** The `<N>` of `idle for <N> min` (agent-runner Requirement 9.18): minutes, rounded, at least 1. */
export function idleMinutes(timeoutS: number): number {
  return Math.max(1, Math.round(timeoutS / 60));
}

function boundedInteger(env: EnvSource, name: string, fallback: number, min: number, max: number): number {
  const raw = readString(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!INTEGER.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigError(name, `${name} must be an integer from ${min} to ${max} (got ${describe(raw)})`);
  }
  return value;
}

/** True for `a.b.c.d:port` with every octet 0..255 and port 1..65535. */
export function isProbeTarget(entry: string): boolean {
  const m = PROBE_TARGET.exec(entry);
  if (m === null) return false;
  const octets = m.slice(1, 5).map(Number);
  const port = Number(m[5]);
  return octets.every((o) => o <= 255) && port >= 1 && port <= 65535;
}

function parseEgressProbes(env: EnvSource): readonly string[] {
  const name = "SEANCE_SANDBOX_EGRESS_PROBES";
  const raw = readString(env, name);
  if (raw === undefined) return ["1.1.1.1:443"];
  const entries = raw.split(",").map((e) => e.trim());
  if (entries.length > MAX_EGRESS_PROBES || entries.some((e) => !isProbeTarget(e))) {
    throw new ConfigError(
      name,
      `${name} must be a comma-separated list of 1 to ${MAX_EGRESS_PROBES} entries of the form <IPv4>:<port> (got ${describe(raw)})`,
    );
  }
  return entries;
}

function parseBlockedCidrs(env: EnvSource): readonly string[] {
  const name = "SEANCE_SANDBOX_BLOCKED_CIDRS";
  const raw = readString(env, name);
  if (raw === undefined) return [];
  const entries = raw.split(",").map((e) => e.trim());
  if (entries.length > MAX_EGRESS_PROBES || entries.some((e) => !isCidr(e))) {
    throw new ConfigError(
      name,
      `${name} must be a comma-separated list of 1 to ${MAX_EGRESS_PROBES} IPv4 CIDRs such as 10.0.0.0/16 (got ${describe(raw)})`,
    );
  }
  return entries;
}

/**
 * KIRO_API_KEY, or undefined when unset, empty or whitespace only (sandbox-api-key-auth
 * Requirement 9). Any other value is kept exactly, surrounding whitespace included.
 */
function readApiKey(env: EnvSource): string | undefined {
  const raw = readString(env, "KIRO_API_KEY");
  return raw === undefined || raw.trim() === "" ? undefined : raw;
}

/** Requirement 1: the podman variables; only read when SEANCE_SANDBOX=podman. */
function parseSandbox(env: EnvSource, harness: HarnessKind): SandboxConfig {
  const raw = env["SEANCE_SANDBOX"];
  if (raw === undefined || raw === "" || raw === "none") return { mode: "none" };
  if (raw !== "podman") {
    throw new ConfigError("SEANCE_SANDBOX", `SEANCE_SANDBOX must be "none" or "podman" (got ${describe(raw)})`);
  }
  if (harness === "headless") {
    throw new ConfigError(
      "SEANCE_HARNESS",
      "SEANCE_HARNESS=headless cannot be sandboxed: use SEANCE_HARNESS=acp (or unset) with SEANCE_SANDBOX=podman",
    );
  }
  const podmanBin = requireNonEmpty(env, "SEANCE_PODMAN_BIN", "podman");
  assertMountSafe("SEANCE_PODMAN_BIN", podmanBin);

  const image = requireNonEmpty(env, "SEANCE_SANDBOX_IMAGE");
  assertMountSafe("SEANCE_SANDBOX_IMAGE", image);
  if (image.startsWith("-") || !IMAGE_DIGEST.test(image)) {
    throw new ConfigError(
      "SEANCE_SANDBOX_IMAGE",
      `SEANCE_SANDBOX_IMAGE must be pinned by digest as <name>@sha256:<64 hex> (got ${describe(image)}); ` +
        `read the digest with: podman image inspect --format '{{.Digest}}' <name>`,
    );
  }

  const authRaw = readString(env, "SEANCE_SANDBOX_AUTH_DIR");
  const authDir = authRaw === undefined || authRaw.trim() === "" ? undefined : authRaw;
  const rawKey = readString(env, "KIRO_API_KEY");
  if (rawKey !== undefined && /[\0\r\n]/.test(rawKey)) {
    // Never include the value.
    throw new ConfigError("KIRO_API_KEY", "KIRO_API_KEY contains a NUL, CR or LF character");
  }
  if (authDir === undefined && readApiKey(env) === undefined) {
    throw new ConfigError(
      "SEANCE_SANDBOX_AUTH_DIR",
      "podman mode needs a Kiro credential: set SEANCE_SANDBOX_AUTH_DIR (login state, mounted read-only) or KIRO_API_KEY (forwarded by name); one of them is required",
    );
  }
  if (authDir !== undefined) assertMountSafe("SEANCE_SANDBOX_AUTH_DIR", authDir);

  const memory = readString(env, "SEANCE_SANDBOX_MEMORY") ?? "2g";
  if (!MEMORY.test(memory)) {
    throw new ConfigError("SEANCE_SANDBOX_MEMORY", `SEANCE_SANDBOX_MEMORY must match <n>k, <n>m or <n>g (got ${describe(memory)})`);
  }
  const cpus = readString(env, "SEANCE_SANDBOX_CPUS") ?? "2";
  const cpuValue = Number(cpus);
  if (!CPUS.test(cpus) || !(cpuValue > 0) || cpuValue > 64) {
    throw new ConfigError("SEANCE_SANDBOX_CPUS", `SEANCE_SANDBOX_CPUS must be a decimal greater than 0 and at most 64 (got ${describe(cpus)})`);
  }
  const kiroBin = requireNonEmpty(env, "SEANCE_SANDBOX_KIRO_BIN", "kiro-cli");
  if (!isSandboxKiroBin(kiroBin)) {
    throw new ConfigError(
      "SEANCE_SANDBOX_KIRO_BIN",
      `SEANCE_SANDBOX_KIRO_BIN must be a bare command name or an absolute path in the image, not under /home/agent, /tmp or /run, which are noexec or credential mounts (got ${describe(kiroBin)})`,
    );
  }

  const ignored: "SEANCE_KIRO_BIN"[] = [];
  if (readString(env, "SEANCE_KIRO_BIN") !== undefined) ignored.push("SEANCE_KIRO_BIN");

  return {
    mode: "podman",
    podmanBin,
    image,
    authDir,
    memory: memory.toLowerCase(),
    cpus,
    pids: boundedInteger(env, "SEANCE_SANDBOX_PIDS", 256, 16, 4096),
    timeoutS: boundedInteger(env, "SEANCE_SANDBOX_TIMEOUT_S", 86_400, 60, 604_800),
    kiroBin,
    egressProbes: parseEgressProbes(env),
    blockedCidrs: parseBlockedCidrs(env),
    ignored,
  };
}

/**
 * Pure: reads only `env` (and `cwd` for the default agents directory), no I/O.
 * Throws ConfigError naming the variable; never includes the KIRO_API_KEY value.
 */
export function loadRunnerConfig(env: EnvSource, cwd: string = process.cwd()): RunnerConfig {
  const harness = parseHarness(env);
  const sandbox = parseSandbox(env, harness);
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
  if (sandbox.mode === "podman") {
    // Both become `--mount` sources (the session directories live under the workspaces root).
    assertMountSafe("SEANCE_AGENTS_DIR", agentsDir);
    assertMountSafe("SEANCE_WORKSPACES", workspaces);
  }

  return {
    sandbox,
    harness,
    kiroBin,
    kiroApiKey: readApiKey(env),
    targetRepo,
    workspaces,
    agentsDir,
    promptTimeoutMs: positiveInteger(env, "SEANCE_PROMPT_TIMEOUT_MS", DEFAULT_PROMPT_TIMEOUT_MS),
    // Present only when set, so the config of an unconfigured runner is unchanged; the runner applies
    // DEFAULT_IDLE_TIMEOUT_S (900) when it is absent.
    ...(readString(env, "SEANCE_IDLE_TIMEOUT_S") !== undefined
      ? { idleTimeoutS: boundedInteger(env, "SEANCE_IDLE_TIMEOUT_S", DEFAULT_IDLE_TIMEOUT_S, 60, 86_400) }
      : {}),
    channelCreditCap: parseCreditCap(env),
    inviteRate: positiveInteger(env, "SEANCE_INVITE_RATE", DEFAULT_INVITE_RATE),
    inviters: parseInviters(env),
    ...parseHardening(env),
  };
}

/**
 * Startup warnings about the credential setup. With both the login directory and the key set, Kiro
 * prefers the login, so the key is only a fallback. Pure; never includes the key value.
 */
export function sandboxAuthWarnings(
  config: RunnerConfig,
): readonly { readonly message: string; readonly fields: { readonly variables: readonly string[] } }[] {
  const key = config.kiroApiKey;
  if (config.sandbox.mode !== "podman" || config.sandbox.authDir === undefined || key === undefined || key === "") return [];
  return [
    {
      message:
        "KIRO_API_KEY and SEANCE_SANDBOX_AUTH_DIR are both set; the login in SEANCE_SANDBOX_AUTH_DIR takes precedence over KIRO_API_KEY inside the sandbox",
      fields: { variables: ["KIRO_API_KEY", "SEANCE_SANDBOX_AUTH_DIR"] },
    },
  ];
}

/** public-hardening defaults (Requirements 5 and 9); applied by the runner when a field is absent. */
export const HARDENING_DEFAULTS = {
  maxAgentChannels: 2,
  maxContainers: 6,
  gitTimeoutMs: 60_000,
  worktreeMaxBytes: 500 * 1024 * 1024,
} as const;

/**
 * public-hardening Requirements 5 and 9. Each field is present only when its variable is set, so
 * a configuration without them stays exactly as before; the runner applies HARDENING_DEFAULTS.
 */
function parseHardening(env: EnvSource): {
  readonly dailyCreditCap?: number;
  readonly killSwitchFile?: string;
  readonly maxAgentChannels?: number;
  readonly maxContainers?: number;
  readonly gitTimeoutMs?: number;
  readonly worktreeMaxBytes?: number;
} {
  const out: Record<string, number | string> = {};
  const capRaw = readString(env, "SEANCE_DAILY_CREDIT_CAP");
  if (capRaw !== undefined) {
    const value = capRaw.trim() === "" ? Number.NaN : Number(capRaw.trim());
    if (!Number.isFinite(value) || value <= 0) {
      throw new ConfigError(
        "SEANCE_DAILY_CREDIT_CAP",
        `SEANCE_DAILY_CREDIT_CAP must be a finite number greater than 0 (got ${describe(capRaw)})`,
      );
    }
    out["dailyCreditCap"] = value;
  }
  const kill = readString(env, "SEANCE_KILL_SWITCH_FILE");
  if (kill !== undefined) {
    if (kill.trim() === "") {
      throw new ConfigError("SEANCE_KILL_SWITCH_FILE", `SEANCE_KILL_SWITCH_FILE must not be blank (got ${describe(kill)})`);
    }
    out["killSwitchFile"] = kill;
  }
  const ints: readonly (readonly [string, string])[] = [
    ["SEANCE_MAX_AGENT_CHANNELS", "maxAgentChannels"],
    ["SEANCE_MAX_CONTAINERS", "maxContainers"],
    ["SEANCE_GIT_TIMEOUT_MS", "gitTimeoutMs"],
    ["SEANCE_WORKTREE_MAX_BYTES", "worktreeMaxBytes"],
  ];
  for (const [name, field] of ints) {
    if (readString(env, name) !== undefined) out[field] = positiveInteger(env, name, 1);
  }
  return out;
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
  let sandbox = config.sandbox;
  if (sandbox.mode === "podman") {
    // Requirement 1.4, 3.2 (d): the auth dir is an existing directory; mount sources are realpaths.
    if (sandbox.authDir !== undefined) {
      if (!(await isDirectory(sandbox.authDir))) {
        throw new ConfigError(
          "SEANCE_SANDBOX_AUTH_DIR",
          `SEANCE_SANDBOX_AUTH_DIR is not an existing directory (got ${describe(sandbox.authDir)})`,
        );
      }
      const authDir = await realpath(sandbox.authDir);
      assertMountSafe("SEANCE_SANDBOX_AUTH_DIR", authDir);
      sandbox = { ...sandbox, authDir };
    }
  }
  let workspaces: string;
  try {
    await mkdir(config.workspaces, { recursive: true });
    workspaces = await realpath(config.workspaces);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(
      "SEANCE_WORKSPACES",
      `SEANCE_WORKSPACES could not be created (got ${describe(config.workspaces)}): ${reason}`,
    );
  }
  if (sandbox.mode !== "podman") return { ...config, workspaces };
  const agentsDir = await realpath(config.agentsDir);
  assertMountSafe("SEANCE_WORKSPACES", workspaces);
  assertMountSafe("SEANCE_AGENTS_DIR", agentsDir);
  return { ...config, workspaces, agentsDir, sandbox };
}
