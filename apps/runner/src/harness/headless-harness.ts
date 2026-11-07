import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { RunnerConfig } from "../config.js";
import type { Unsubscribe } from "../ports.js";
import type { AgentProfile } from "../registry/agent-profile.js";
import type {
  AgentHarness,
  HarnessSession,
  PermissionHandler,
  ProcessEvent,
  SessionEvent,
  TurnResult,
} from "./harness.js";
import { buildSpawnSpec } from "./spawn.js";

/**
 * Fallback harness: one `kiro-cli chat --agent <kiroAgent> --no-interactive <prompt>`
 * invocation per prompt, cwd = the session cwd (the channel worktree).
 *
 * LIMITATION: headless mode has no channel for `session/request_permission`, so
 * the `onPermission` handler is never called and the runner cannot gate tool use
 * by IRC mode. Write-capable headless operation (shell, file writes, commits for
 * `+o` agents) is out of scope; use it only with read-only agent profiles.
 * There is no per-agent process, so `terminate` is a no-op, and no credits are
 * reported because no metering frames exist on this path.
 */

const STDERR_TAIL_BYTES = 2048;

type HeadlessConfig = Pick<RunnerConfig, "kiroBin" | "kiroApiKey" | "agentsDir">;

export class HeadlessHarness implements AgentHarness {
  readonly #config: HeadlessConfig;
  readonly #baseEnv: Readonly<Record<string, string | undefined>>;
  readonly #sessions = new Set<HeadlessSession>();

  constructor(
    config: HeadlessConfig,
    baseEnv: Readonly<Record<string, string | undefined>> = process.env,
  ) {
    this.#config = config;
    this.#baseEnv = baseEnv;
  }

  async openSession(
    profile: AgentProfile,
    opts: { readonly cwd: string; readonly onPermission: PermissionHandler },
  ): Promise<HarnessSession> {
    // `onPermission` is intentionally unused: see the limitation above.
    const spec = buildSpawnSpec(profile, this.#config, this.#baseEnv);
    const session = new HeadlessSession(
      randomUUID(),
      spec.command,
      ["chat", "--agent", profile.kiroAgent, "--no-interactive"],
      opts.cwd,
      spec.env,
      (s) => this.#sessions.delete(s),
    );
    this.#sessions.add(session);
    return session;
  }

  async terminate(): Promise<void> {
    // No per-agent process exists between prompts.
  }

  onProcessEvent(_listener: (e: ProcessEvent) => void): Unsubscribe {
    // Never emits "hung" or "exited": children live for one prompt only.
    return () => undefined;
  }

  hasProcess(_profile: AgentProfile): boolean {
    return false;
  }

  async dispose(): Promise<void> {
    for (const s of this.#sessions) s.cancel();
    this.#sessions.clear();
  }
}

class HeadlessSession implements HarnessSession {
  readonly #listeners = new Set<(e: SessionEvent) => void>();
  #child: ChildProcess | undefined;
  #cancelled = false;

  constructor(
    readonly id: string,
    private readonly command: string,
    private readonly baseArgs: readonly string[],
    private readonly cwd: string,
    private readonly env: Readonly<Record<string, string | undefined>>,
    private readonly onClose: (s: HeadlessSession) => void,
  ) {}

  prompt(text: string): Promise<TurnResult> {
    if (this.#child !== undefined) {
      return Promise.reject(new Error(`headless session ${this.id}: a prompt is already running`));
    }
    this.#cancelled = false;
    return new Promise<TurnResult>((resolve, reject) => {
      // Arg array, no shell: the prompt is a single argv entry.
      const child = spawn(this.command, [...this.baseArgs, text], {
        cwd: this.cwd,
        env: this.env as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      this.#child = child;

      let pending = "";
      let stderrTail = "";
      let settled = false;
      const emitLine = (line: string): void => {
        const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (clean !== "") this.#emit({ kind: "message-chunk", text: clean });
      };
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        this.#child = undefined;
        fn();
      };

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        pending += chunk;
        let nl = pending.indexOf("\n");
        while (nl !== -1) {
          emitLine(pending.slice(0, nl));
          pending = pending.slice(nl + 1);
          nl = pending.indexOf("\n");
        }
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
      });
      child.once("error", (err) => {
        settle(() =>
          reject(new Error(`failed to start ${this.command} for session ${this.id}: ${err.message}`)),
        );
      });
      child.once("close", (code, signal) => {
        if (pending !== "") emitLine(pending);
        pending = "";
        settle(() => {
          if (this.#cancelled) {
            resolve({ stopReason: "cancelled" });
          } else if (code === 0) {
            resolve({ stopReason: "end_turn" });
          } else {
            const how = signal !== null ? `signal ${signal}` : `exit code ${String(code)}`;
            reject(
              new Error(
                `kiro-cli chat exited with ${how} for session ${this.id}: ${stderrTail.trim()}`,
              ),
            );
          }
        });
      });
    });
  }

  cancel(): void {
    const child = this.#child;
    if (child === undefined) return;
    this.#cancelled = true;
    child.kill("SIGTERM");
  }

  async close(): Promise<void> {
    this.cancel();
    this.#listeners.clear();
    this.onClose(this);
  }

  onEvent(listener: (e: SessionEvent) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #emit(e: SessionEvent): void {
    for (const l of [...this.#listeners]) l(e);
  }
}
