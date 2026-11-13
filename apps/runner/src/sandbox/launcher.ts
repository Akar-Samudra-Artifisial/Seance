/**
 * PodmanLauncher (agent-sandbox Requirements 3, 7.7, 10; design "Launcher"): preflight checks, the
 * spawn spec of one agent container, and removal by name or label. Never falls back to a host
 * process: every failure is a `SandboxError`.
 */
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { irc_lower } from "@seance/irc-protocol";
import { allowListedEnv, type EnvLike } from "../child-env.js";
import type { PodmanSandboxConfig } from "../config.js";
import type { RunnerLogger } from "../log.js";
import { SandboxError } from "./errors.js";
import * as F from "./flags.js";
import { buildPodmanRunArgs, buildProbeArgs, isForwardable } from "./podman-args.js";
import { probeTargetIn } from "./cidr.js";
import { isWithin, resolveMountPaths } from "./paths.js";
import { scrubDetail } from "./notices.js";

export type ExecResult = { readonly code: number; readonly stdout: string; readonly stderr: string };

/** Runs the podman binary; `code` is -1 when it could not be started (ENOENT and the like). */
export interface PodmanExec {
  run(bin: string, args: readonly string[], env: Readonly<Record<string, string | undefined>>): Promise<ExecResult>;
}

const EXEC_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 1024 * 1024;

/** Default `PodmanExec`: `execFile` (no shell), bounded in time and output. */
export const execPodman: PodmanExec = {
  run(bin, args, env) {
    return new Promise((resolve) => {
      execFile(
        bin,
        [...args],
        { env: { ...env }, encoding: "utf8", timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true },
        (error, stdout, stderr) => {
          if (error === null) {
            resolve({ code: 0, stdout, stderr });
            return;
          }
          const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
          resolve({ code: typeof code === "number" ? code : -1, stdout, stderr: stderr === "" ? error.message : stderr });
        },
      );
    });
  },
};

/** What `AcpHarness` needs to spawn one container (design: `SandboxSpec extends SpawnSpec`). */
export type SandboxSpec = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly containerName: string;
};

export type LauncherOptions = {
  readonly config: PodmanSandboxConfig;
  /** Realpath of SEANCE_AGENTS_DIR. */
  readonly agentsDir: string;
  /** Realpath of SEANCE_WORKSPACES (the Worktree_Root). */
  readonly worktreeRoot: string;
  readonly targetRepo?: string;
  readonly logger: RunnerLogger;
  readonly exec?: PodmanExec;
  /** Base environment of the podman process; defaults to `process.env`. */
  readonly baseEnv?: EnvLike;
  /** 8 hex characters; injectable for tests. */
  readonly random?: () => string;
  /** KIRO_API_KEY; goes only into the env of the agent `podman run`, never into argv. Empty counts as unset. */
  readonly apiKey?: string;
};

/** Never forwarded into a container, even from test extras (Requirement 6.3, 6.4). */
const HOST_ONLY: ReadonlySet<string> = new Set(["PATH", "HOME", "TMPDIR", "XDG_RUNTIME_DIR", "KIRO_API_KEY"]);

/** Container names the sweep may remove: `seance-<nick or probe>-<8 hex>-<8 hex>`. */
const SWEPT_NAME = /^seance-[a-z0-9-]{1,40}-[0-9a-f]{8}-[0-9a-f]{8}$/;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** `[a-z0-9-]`, at most 40 characters: the nick part of a Container_Name and the agent label. */
export function containerNick(nick: string): string {
  const cleaned = irc_lower(nick).replace(/[^a-z0-9-]/g, "-").slice(0, 40);
  return cleaned === "" ? "agent" : cleaned;
}

/** Major version from `podman version 5.2.1` (or `podman version 5.0.0-dev`); undefined when unreadable. */
export function parsePodmanMajor(stdout: string): number | undefined {
  const m = /\bversion\s+(\d+)\.\d+/i.exec(stdout);
  return m === null ? undefined : Number(m[1]);
}

/** `host.security.rootless` from `podman info --format json`; undefined when unreadable. */
export function parseRootless(stdout: string): boolean | undefined {
  try {
    const info: unknown = JSON.parse(stdout);
    const host = (info as { host?: { security?: { rootless?: unknown } } }).host;
    const v = host?.security?.rootless;
    return typeof v === "boolean" ? v : undefined;
  } catch {
    return undefined;
  }
}

const lastLine = (text: string): string => {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  return lines.at(-1) ?? "";
};

export class PodmanLauncher {
  readonly #o: LauncherOptions;
  readonly #exec: PodmanExec;
  readonly #random: () => string;
  readonly #workspacesLabel: string;
  readonly #apiKey: string | undefined;
  /** Names this run created and has not removed yet (Requirement 10.7). */
  readonly #created = new Set<string>();
  /** Names whose removal failed; retried by `sweep` (Requirement 10.3). */
  readonly #retry = new Set<string>();

  constructor(o: LauncherOptions) {
    this.#o = o;
    this.#exec = o.exec ?? execPodman;
    this.#random = o.random ?? ((): string => randomBytes(4).toString("hex"));
    this.#apiKey = o.apiKey === undefined || o.apiKey === "" ? undefined : o.apiKey;
    this.#workspacesLabel = sha256(o.worktreeRoot).slice(0, 16);
  }

  get workspacesLabel(): string {
    return this.#workspacesLabel;
  }

  /** Container names created in this run and not yet removed (tests, P5). */
  get liveNames(): readonly string[] {
    return [...this.#created];
  }

  /** Environment of the podman process: allow-list, XDG_RUNTIME_DIR, explicit extras; never KIRO_API_KEY. */
  podmanEnv(extra: EnvLike = {}): Record<string, string | undefined> {
    const base = this.#o.baseEnv ?? process.env;
    const env: Record<string, string | undefined> = allowListedEnv(base);
    const xdg = base["XDG_RUNTIME_DIR"];
    if (xdg !== undefined && xdg !== "") env["XDG_RUNTIME_DIR"] = xdg;
    for (const [name, value] of Object.entries(extra)) {
      if (name === "KIRO_API_KEY" || value === undefined) continue;
      env[name] = value;
    }
    return env;
  }

  /** One stderr line for a log or SandboxError detail, with the key removed (Requirement 2.3). */
  #scrub(stderr: string): string {
    return scrubDetail(lastLine(stderr), [this.#apiKey]);
  }

  async #podman(args: readonly string[], extra: EnvLike = {}): Promise<ExecResult> {
    const result = await this.#exec.run(this.#o.config.podmanBin, args, this.podmanEnv(extra));
    if (result.code === -1 && /ENOENT|not found|EACCES/i.test(result.stderr)) {
      throw new SandboxError(
        "podman-missing",
        `podman not found: ${JSON.stringify(this.#o.config.podmanBin)} could not be started; install Podman 5 or set SEANCE_PODMAN_BIN`,
      );
    }
    return result;
  }

  async #checkVersion(): Promise<void> {
    const r = await this.#podman(["--version"]);
    if (r.code !== 0) {
      throw new SandboxError("podman-missing", `podman not found: "podman --version" failed with exit code ${r.code}`, this.#scrub(r.stderr));
    }
    const major = parsePodmanMajor(r.stdout);
    if (major === undefined || major < 5) {
      throw new SandboxError(
        "podman-version",
        `podman too old (need 5 or newer): "podman --version" reported ${JSON.stringify(lastLine(r.stdout))}; upgrade Podman`,
      );
    }
  }

  async #checkImage(): Promise<void> {
    const r = await this.#podman(["image", "exists", this.#o.config.image]);
    if (r.code !== 0) {
      throw new SandboxError(
        "image-missing",
        "sandbox image not found: SEANCE_SANDBOX_IMAGE is not present locally under its digest; build it from sandbox/Dockerfile (the runner never pulls)",
      );
    }
  }

  /** Requirement 3.5: re-run before every container start. */
  async quickCheck(): Promise<void> {
    await this.#checkVersion();
    await this.#checkImage();
  }

  /** Requirement 3.2: version, rootless, image, auth dir, Probe; in that order. */
  async preflight(): Promise<void> {
    await this.#checkVersion();
    const info = await this.#podman(["info", "--format", "json"]);
    if (info.code !== 0 || parseRootless(info.stdout) !== true) {
      throw new SandboxError(
        "not-rootless",
        "podman is not rootless: podman info does not report host.security.rootless=true; run the runner as an unprivileged user with rootless Podman",
      );
    }
    await this.#checkImage();
    const authDir = this.#o.config.authDir;
    if (authDir !== undefined) {
      let authOk = false;
      try {
        authOk = (await stat(authDir)).isDirectory();
      } catch {
        authOk = false;
      }
      if (!authOk) {
        throw new SandboxError("auth-missing", "SEANCE_SANDBOX_AUTH_DIR is not an existing directory; point it at the Kiro login state");
      }
    }
    await this.#probe();
  }

  async #probe(): Promise<void> {
    const server = await listenLoopback();
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const name = `seance-probe-${this.#random()}-${this.#random()}`;
    try {
      this.#created.add(name);
      const r = await this.#podman(
        buildProbeArgs({
          image: this.#o.config.image,
          containerName: name,
          workspacesLabel: this.#workspacesLabel,
          loopbackPort: port,
          // Review finding 4: every podman start checks the egress rule, not only IRCD_PUBLIC=1.
          extraTargets: [...this.#o.config.egressProbes, ...this.#o.config.blockedCidrs.map(probeTargetIn)],
        }),
      );
      if (r.code === F.PROBE_EXIT.ok) return;
      const which =
        r.code === F.PROBE_EXIT.loopback
          ? "the host loopback is reachable through the container gateway (check the pasta --no-map-gw flag)"
          : r.code === F.PROBE_EXIT.metadata
            ? "the metadata endpoint 169.254.169.254 is reachable (load sandbox/seance-sandbox.nft)"
            : r.code === F.PROBE_EXIT.egress
              ? "a destination outside the egress allow-list, or inside SEANCE_SANDBOX_BLOCKED_CIDRS, is reachable (load the default-deny rule of sandbox/seance-sandbox.nft)"
              : r.code === F.PROBE_EXIT.noNetcat
                ? "the image has no nc for seance-probe"
                : `seance-probe exited with code ${r.code}`;
      throw new SandboxError("probe-failed", `network isolation check failed: ${which}`, this.#scrub(r.stderr));
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      await this.remove(name).catch((err: unknown) => {
        this.#o.logger.warn("probe container removal failed", { reason: err instanceof Error ? err.message : String(err) });
      });
    }
  }

  /**
   * The spawn spec of one agent container (Requirement 4 to 6). `forward` are extra variable names
   * (test launchers); their values go to the podman process environment, never to argv.
   */
  async spec(o: {
    readonly nick: string;
    readonly kiroAgent: string;
    readonly sessionCwd: string;
    readonly extraEnv?: EnvLike;
  }): Promise<SandboxSpec> {
    const paths = await resolveMountPaths({
      sessionCwd: o.sessionCwd,
      worktreeRoot: this.#o.worktreeRoot,
      agentsDir: this.#o.agentsDir,
      ...(this.#o.config.authDir !== undefined ? { authDir: this.#o.config.authDir } : {}),
      ...(this.#o.targetRepo !== undefined ? { targetRepo: this.#o.targetRepo } : {}),
    });
    const privateRoot = `${this.#o.worktreeRoot}/_private`;
    const privateSession = isWithin(paths.sessionCwd, privateRoot);
    const nick = containerNick(o.nick);
    const containerName = `seance-${nick}-${sha256(paths.sessionCwd).slice(0, 8)}-${this.#random()}`;
    const base = this.#o.baseEnv ?? process.env;
    const extra = o.extraEnv ?? {};
    const forwardEnv = [
      ...Object.keys(base).filter((n) => isForwardable(n) && base[n] !== undefined),
      ...Object.keys(extra).filter((n) => extra[n] !== undefined && !HOST_ONLY.has(n) && !isForwardable(n)),
    ].sort();
    const args = buildPodmanRunArgs({
      config: this.#o.config,
      agentsDir: this.#o.agentsDir,
      sessionCwd: paths.sessionCwd,
      worktreeRoot: this.#o.worktreeRoot,
      privateSession,
      containerName,
      labels: { workspaces: this.#workspacesLabel, agent: nick },
      kiroAgent: o.kiroAgent,
      forwardEnv: [...new Set(forwardEnv)],
      forwardApiKey: this.#apiKey !== undefined,
    });
    this.#created.add(containerName);
    // Only this spec carries the key; every other podman call uses podmanEnv() without it.
    const env = this.podmanEnv(extra);
    if (this.#apiKey !== undefined) env["KIRO_API_KEY"] = this.#apiKey;
    return { command: this.#o.config.podmanBin, args, cwd: this.#o.agentsDir, env, containerName };
  }

  /**
   * Requirement 10.1: `stop -t 2`, then `rm -f --ignore`, both awaited. Only names this run created
   * (10.7). A failed removal is remembered for the next `sweep` and rethrown as `remove-failed`.
   */
  async remove(name: string): Promise<void> {
    if (!this.#created.has(name) && !this.#retry.has(name)) {
      this.#o.logger.warn("container removal skipped: not created by this runner", { container: name });
      return;
    }
    const stop = await this.#podman(["stop", "-t", String(F.STOP_TIMEOUT_S), name]);
    if (stop.code !== 0) this.#o.logger.debug("podman stop failed (container may be gone)", { container: name, code: stop.code });
    const rm = await this.#podman(["rm", "-f", "--ignore", name]);
    if (rm.code !== 0) {
      this.#retry.add(name);
      this.#o.logger.error("container removal failed", { container: name, code: rm.code, stderr: this.#scrub(rm.stderr) });
      throw new SandboxError("remove-failed", `container ${name} could not be removed; it is retried at the next sweep`, this.#scrub(rm.stderr));
    }
    this.#created.delete(name);
    this.#retry.delete(name);
  }

  /**
   * Requirement 10.4: removes every container labelled with this Worktree_Root, plus the names whose
   * removal failed earlier. Returns how many containers were removed. Never throws.
   */
  async sweep(): Promise<number> {
    let removed = 0;
    try {
      // Names, not ids: the names this run created can then be forgotten once swept (finding 6).
      const ps = await this.#podman([
        "ps",
        "-a",
        "--format",
        "{{.Names}}",
        "--filter",
        `label=${F.LABEL_SANDBOX}=1`,
        "--filter",
        `label=${F.LABEL_WORKSPACES}=${this.#workspacesLabel}`,
      ]);
      // Only Séance container names go to `rm`; nothing that could be read as a flag.
      const listed = ps.code === 0 ? ps.stdout.split(/\s+/).filter((n) => SWEPT_NAME.test(n)) : [];
      const targets = [...new Set([...listed, ...this.#retry])];
      if (targets.length > 0) {
        const rm = await this.#podman(["rm", "-f", "--ignore", ...targets]);
        if (rm.code === 0) {
          removed = targets.length;
          for (const name of targets) {
            this.#created.delete(name);
            this.#retry.delete(name);
          }
        } else {
          this.#o.logger.error("sandbox sweep removal failed", { code: rm.code, stderr: this.#scrub(rm.stderr) });
        }
      }
    } catch (err) {
      this.#o.logger.error("sandbox sweep failed", { reason: err instanceof Error ? err.message : String(err) });
    }
    return removed;
  }

}

function listenLoopback(): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      socket.destroy();
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve(server);
    });
  });
}
