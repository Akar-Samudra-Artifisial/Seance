/**
 * Pure `podman run` argument builder (agent-sandbox Requirements 4 to 6, design "The generated
 * command"). Every flag comes from a fixed list in a fixed order; untrusted text only ever lands
 * inside a validated `--mount` value, a label value, `--name` or the final `--agent` value.
 */
import type { PodmanSandboxConfig } from "../config.js";
import { SandboxError } from "./errors.js";
import * as F from "./flags.js";
import { isSandboxKiroBin } from "./kiro-bin.js";
import { assertMountPaths } from "./paths.js";

export interface PodmanRunInput {
  readonly config: Pick<PodmanSandboxConfig, "image" | "authDir" | "memory" | "cpus" | "pids" | "timeoutS" | "kiroBin">;
  /** Realpath of SEANCE_AGENTS_DIR. */
  readonly agentsDir: string;
  /** Realpath of the session directory, inside the worktree root. */
  readonly sessionCwd: string;
  /** Realpath of SEANCE_WORKSPACES. */
  readonly worktreeRoot: string;
  /** True for `<root>/_private/<nick>`: only one container mounts it, so it gets `:Z` (D21). */
  readonly privateSession: boolean;
  readonly containerName: string;
  readonly labels: { readonly workspaces: string; readonly agent: string };
  readonly kiroAgent: string;
  /** Variable names forwarded by name (`-e NAME`); values never travel in argv. */
  readonly forwardEnv: readonly string[];
}

/** Requirement 4.5: a Kiro agent name that can never be read as a flag. */
export const KIRO_AGENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Glossary Container_Name: `seance-<nick>-<8 hex>-<8 hex>`, nick restricted to `[a-z0-9-]`. */
export const CONTAINER_NAME_PATTERN = /^seance-[a-z0-9-]{1,40}-[0-9a-f]{8}-[0-9a-f]{8}$/;
const LABEL_HEX = /^[0-9a-f]{16}$/;
const LABEL_AGENT = /^[a-z0-9-]{1,40}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const UNSAFE_PATH = /[,"\0\r\n]/;

/** Names that may be forwarded (Requirement 6.1): the allow-list of `child-env.ts` minus host paths. */
export function isForwardable(name: string): boolean {
  if (name === "LANG" || name === "TERM" || name.startsWith("LC_")) return ENV_NAME.test(name);
  return false;
}

/** Names forbidden even for test launchers: host paths and the Kiro credential (Requirement 6.3, 6.4). */
const NEVER_FORWARDED: ReadonlySet<string> = new Set(["PATH", "HOME", "TMPDIR", "KIRO_API_KEY", "XDG_RUNTIME_DIR"]);

/** Flags the builder emits (each at most once, apart from the repeatable ones below). */
export const FIXED_FLAGS: readonly string[] = [
  "-i",
  "--rm",
  "--name",
  "--label",
  "--read-only",
  "--cap-drop",
  "--security-opt",
  "--pids-limit",
  "--memory",
  "--memory-swap",
  "--cpus",
  "--user",
  "--userns",
  "--pull",
  "--http-proxy",
  "--no-hosts",
  "--log-driver",
  "--timeout",
  "--stop-timeout",
  "--hostname",
  "--workdir",
  "--network",
  "--tmpfs",
  "--mount",
  "-e",
];

function fail(message: string): never {
  throw new SandboxError("invalid-input", `sandbox argv refused: ${message}`);
}

function checkPath(what: string, path: string): void {
  if (!path.startsWith("/")) fail(`${what} must be an absolute path`);
  if (UNSAFE_PATH.test(path)) fail(`${what} contains a comma, a double quote, NUL, CR or LF`);
}

/** One `--mount` value from validated parts (Requirement 5.1, 5.2, 5.7). */
function bindMount(src: string, dst: string, readOnly: boolean, relabel: string): string {
  return [
    "type=bind",
    `src=${src}`,
    `dst=${dst}`,
    readOnly ? F.MOUNT_RO : F.MOUNT_RW,
    F.MOUNT_PROPAGATION,
    F.MOUNT_NOSUID,
    F.MOUNT_NODEV,
    relabel,
  ].join(",");
}

/**
 * Builds the argv after the podman binary (`run ... <image> acp --agent <name>`). Throws
 * `SandboxError("invalid-input")` and builds nothing for any invalid part.
 */
export function buildPodmanRunArgs(i: PodmanRunInput): readonly string[] {
  checkPath("the session directory", i.sessionCwd);
  checkPath("the agents directory", i.agentsDir);
  checkPath("the workspaces root", i.worktreeRoot);
  checkPath("the auth directory", i.config.authDir);
  assertMountPaths({
    sessionCwd: i.sessionCwd,
    worktreeRoot: i.worktreeRoot,
    agentsDir: i.agentsDir,
    authDir: i.config.authDir,
  });
  if (!isSandboxKiroBin(i.config.kiroBin)) fail("the kiro-cli command must be a bare name or an image path outside the noexec mounts");
  if (!KIRO_AGENT_PATTERN.test(i.kiroAgent)) fail(`kiroAgent ${JSON.stringify(i.kiroAgent)} is not allowed in podman mode`);
  if (!CONTAINER_NAME_PATTERN.test(i.containerName)) fail("invalid container name");
  if (!LABEL_HEX.test(i.labels.workspaces)) fail("invalid workspaces label");
  if (!LABEL_AGENT.test(i.labels.agent)) fail("invalid agent label");
  if (i.config.image.startsWith("-") || !/^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$/.test(i.config.image)) {
    fail("the image must be pinned by digest");
  }
  if (!/^[1-9][0-9]*[kmg]$/i.test(i.config.memory)) fail("invalid memory limit");
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(i.config.cpus)) fail("invalid cpu limit");
  if (!Number.isInteger(i.config.pids) || i.config.pids < 16 || i.config.pids > 4096) fail("invalid pids limit");
  if (!Number.isInteger(i.config.timeoutS) || i.config.timeoutS < 60 || i.config.timeoutS > 604_800) fail("invalid timeout");
  const seen = new Set<string>();
  for (const name of i.forwardEnv) {
    if (NEVER_FORWARDED.has(name)) fail(`${name} is never forwarded into the sandbox`);
    if (!ENV_NAME.test(name)) fail(`invalid environment variable name ${JSON.stringify(name)}`);
    if (seen.has(name)) fail(`${name} is forwarded twice`);
    seen.add(name);
  }

  const memory = i.config.memory.toLowerCase();
  const sessionRelabel = i.privateSession ? F.MOUNT_RELABEL_PRIVATE : F.MOUNT_RELABEL_SHARED;
  return [
    "run",
    "-i",
    "--rm",
    `--name=${i.containerName}`,
    `--label=${F.LABEL_SANDBOX}=1`,
    `--label=${F.LABEL_WORKSPACES}=${i.labels.workspaces}`,
    `--label=${F.LABEL_AGENT}=${i.labels.agent}`,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    `--pids-limit=${i.config.pids}`,
    `--memory=${memory}`,
    `--memory-swap=${memory}`,
    `--cpus=${i.config.cpus}`,
    `--user=${F.USER}`,
    `--userns=${F.USERNS}`,
    "--pull=never",
    "--http-proxy=false",
    "--no-hosts",
    "--log-driver=none",
    `--timeout=${i.config.timeoutS}`,
    `--stop-timeout=${F.STOP_TIMEOUT_S}`,
    `--hostname=${F.HOSTNAME}`,
    `--workdir=${i.agentsDir}`,
    `--network=${F.NETWORK}`,
    `--tmpfs=${F.TMPFS_TMP}`,
    `--tmpfs=${F.TMPFS_HOME}`,
    `--mount=${bindMount(i.sessionCwd, i.sessionCwd, false, sessionRelabel)}`,
    `--mount=${bindMount(i.agentsDir, i.agentsDir, true, F.MOUNT_RELABEL_SHARED)}`,
    `--mount=${bindMount(i.config.authDir, F.AUTH_MOUNT_POINT, true, F.MOUNT_RELABEL_SHARED)}`,
    "-e",
    `HOME=${F.CONTAINER_HOME}`,
    "-e",
    `TMPDIR=${F.CONTAINER_TMP}`,
    // seance-entry runs this command; it is a validated constant, not a host value or a secret.
    "-e",
    `SEANCE_KIRO_BIN=${i.config.kiroBin}`,
    ...i.forwardEnv.flatMap((name) => ["-e", name]),
    i.config.image,
    "acp",
    "--agent",
    i.kiroAgent,
  ];
}

/**
 * The Probe container (Requirement 3.2 e, 3.3): the production network and isolation flags, no
 * mounts, the probe as the command. `extra` are the egress probe targets of a public deployment.
 */
export function buildProbeArgs(o: {
  readonly image: string;
  readonly containerName: string;
  readonly workspacesLabel: string;
  readonly loopbackPort: number;
  readonly extraTargets: readonly string[];
}): readonly string[] {
  if (!CONTAINER_NAME_PATTERN.test(o.containerName)) fail("invalid container name");
  if (!LABEL_HEX.test(o.workspacesLabel)) fail("invalid workspaces label");
  if (!Number.isInteger(o.loopbackPort) || o.loopbackPort < 1 || o.loopbackPort > 65535) fail("invalid probe port");
  for (const t of o.extraTargets) if (!/^[0-9.]+:[0-9]+$/.test(t)) fail(`invalid probe target ${JSON.stringify(t)}`);
  return [
    "run",
    "--rm",
    `--name=${o.containerName}`,
    `--label=${F.LABEL_SANDBOX}=1`,
    `--label=${F.LABEL_WORKSPACES}=${o.workspacesLabel}`,
    `--label=${F.LABEL_AGENT}=probe`,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    `--user=${F.USER}`,
    `--userns=${F.USERNS}`,
    "--pull=never",
    "--http-proxy=false",
    "--no-hosts",
    "--log-driver=none",
    "--timeout=60",
    `--network=${F.NETWORK}`,
    `--tmpfs=${F.TMPFS_TMP}`,
    `--entrypoint=${F.PROBE_COMMAND}`,
    o.image,
    String(o.loopbackPort),
    ...o.extraTargets,
  ];
}
