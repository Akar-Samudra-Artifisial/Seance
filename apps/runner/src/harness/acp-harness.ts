/**
 * AcpHarness: one `kiro-cli acp` process per Agent, one ACP session per channel.
 * Everything the agent sends is untrusted and is validated at this boundary (Req 2.11, 8.9, 8.10).
 */
import { AcpClient, type AcpClientOptions, type JsonObject } from "../acp/client.js";
import type { Json } from "../acp/frames.js";
import type { Clock, TimerHandle } from "../clock.js";
import type { RunnerConfig } from "../config.js";
import type { RunnerLogger } from "../log.js";
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
import { irc_lower } from "@seance/irc-protocol";
import { SandboxError } from "../sandbox/errors.js";
import type { PodmanLauncher } from "../sandbox/launcher.js";
import { scrubDetail } from "../sandbox/notices.js";
import { buildSandboxSpawnSpec, buildSpawnSpec, type SpawnSpec } from "./spawn.js";
import { resolveTool, ToolCache } from "./tool-info.js";

export type AcpHarnessConfig = Pick<RunnerConfig, "kiroBin" | "kiroApiKey" | "agentsDir">;

export interface AcpHarnessOptions {
  readonly config: AcpHarnessConfig;
  readonly logger: RunnerLogger;
  readonly clock: Clock;
  /** Base environment of the child; defaults to `process.env`. */
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  /**
   * Extra child variables beyond the allow-list, read at every spawn. Meant for test launchers
   * (for example the Fake_Agent's FAKE_AGENT_* variables); production passes nothing.
   */
  readonly extraEnv?: () => Readonly<Record<string, string | undefined>>;
  /** Hung-agent watchdog: max silence during a Turn; defaults to SEANCE_PROMPT_TIMEOUT_MS (120000). */
  readonly promptTimeoutMs?: number;
  /** Grace between SIGTERM and SIGKILL when terminating an agent; defaults to 5000 ms. */
  readonly killGraceMs?: number;
  /**
   * Podman mode (agent-sandbox): one container per (agent, session cwd). Absent means `none` mode,
   * one host process per agent, unchanged.
   */
  readonly sandbox?: PodmanLauncher;
  /**
   * Podman mode: budget for the container to answer `initialize` and `session/new`; defaults to
   * 25000 ms, under the invite pipeline's 30 s, so the sandbox reason wins (Requirement 8.4).
   */
  readonly startTimeoutMs?: number;
  /** Builds the ACP client of a process; defaults to `new AcpClient(o)` (tests: an in-memory client). */
  readonly createClient?: (o: AcpClientOptions) => AcpClient;
}

const DEFAULT_PROMPT_TIMEOUT_MS = 120_000;
const DEFAULT_KILL_GRACE_MS = 5000;
export const DEFAULT_SANDBOX_START_TIMEOUT_MS = 25_000;

/** Kiro fell back to another agent than the requested profile (spike S8, Req 2.15, 2.16). */
export class AgentProfileNotLoadedError extends Error {
  readonly kiroAgent: string;
  readonly actualModeId: string | undefined;

  constructor(kiroAgent: string, actualModeId: string | undefined) {
    super(
      `agent profile ${kiroAgent} not loaded: session/new reported mode ${actualModeId === undefined ? "(none)" : actualModeId}`,
    );
    this.name = "AgentProfileNotLoadedError";
    this.kiroAgent = kiroAgent;
    this.actualModeId = actualModeId;
  }
}

const CANCELLED: JsonObject = { outcome: { outcome: "cancelled" } };

const asObj = (v: Json | undefined): JsonObject | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as JsonObject) : undefined;
const asStr = (v: Json | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Per-process state: the client and the sessions living in it. */
export interface Proc {
  readonly profile: AgentProfile;
  readonly client: AcpClient;
  readonly sessions: Map<string, AcpSession>;
  /** Turns currently in flight in this process (used by the watchdog hooks). */
  inFlight: number;
  /** Watchdog timer; set only while a Turn is in flight. */
  watchdog?: TimerHandle | undefined;
  ready: Promise<void>;
  /** Key in the process map: the nick (`none`) or nick and session cwd (podman). */
  readonly key: string;
  /** Podman mode: the container this process runs (`podman run -i`). */
  readonly containerName?: string;
  /** Podman mode: the memoised removal of the container (stop, then rm). */
  removal?: Promise<void>;
}

class AcpSession implements HarnessSession {
  readonly id: string;
  readonly onPermission: PermissionHandler;
  private readonly listeners = new Set<(e: SessionEvent) => void>();
  private readonly proc: Proc;
  private readonly harness: AcpHarness;
  private closed = false;
  /** Tool metadata by toolCallId for the current turn. */
  readonly tools = new ToolCache();

  constructor(id: string, proc: Proc, harness: AcpHarness, onPermission: PermissionHandler) {
    this.id = id;
    this.proc = proc;
    this.harness = harness;
    this.onPermission = onPermission;
  }

  async prompt(text: string): Promise<TurnResult> {
    if (this.closed) throw new Error(`session/prompt not sent: session ${this.id} is closed`);
    this.harness.turnStarted(this.proc);
    try {
      const res = await this.proc.client.request("session/prompt", {
        sessionId: this.id,
        prompt: [{ type: "text", text }],
      });
      const stopReason = res["stopReason"];
      if (typeof stopReason !== "string") throw new Error("session/prompt result has no string stopReason");
      return { stopReason };
    } finally {
      this.tools.clear();
      this.harness.turnEnded(this.proc);
    }
  }

  cancel(): void {
    if (this.closed) return;
    this.proc.client.notify("session/cancel", { sessionId: this.id });
  }

  close(): Promise<void> {
    this.markClosed();
    this.proc.sessions.delete(this.id);
    // Podman mode: the container serves this session only, so closing it stops and removes the
    // container (Requirement 10.1); a removal failure rejects so the exorcism can report it.
    if (this.proc.containerName !== undefined) return this.harness.retireContainer(this.proc);
    return Promise.resolve();
  }

  markClosed(): void {
    this.closed = true;
    this.listeners.clear();
  }

  onEvent(listener: (e: SessionEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(e: SessionEvent): void {
    for (const l of [...this.listeners]) l(e);
  }
}

export class AcpHarness implements AgentHarness {
  private readonly opts: AcpHarnessOptions;
  private readonly procs = new Map<string, Proc>();
  private readonly processListeners = new Set<(e: ProcessEvent) => void>();
  /** Podman mode: opens in flight by `nick\0cwd` (review finding 2). */
  private readonly opening = new Map<string, Promise<HarnessSession>>();
  /** True once dispose() has started (review finding 3). */
  private disposing = false;

  constructor(opts: AcpHarnessOptions) {
    this.opts = opts;
  }

  openSession(
    profile: AgentProfile,
    opts: { readonly cwd: string; readonly onPermission: PermissionHandler },
  ): Promise<HarnessSession> {
    // Review finding 3: once dispose() has started nothing new may start.
    if (this.disposing) return Promise.reject(this.refusedAfterDispose());
    const launcher = this.opts.sandbox;
    if (launcher === undefined) return this.openHostSession(profile, opts);
    // Review finding 2: one open per (agent, cwd) at a time; the map entry is set before any await.
    const key = `${irc_lower(profile.nick)}\0${opts.cwd}`;
    if (this.opening.has(key)) {
      // Review item 3: a second caller must not silently get the first caller's HarnessSession (and
      // its onPermission), and closing one must not close the other. The pair has one container,
      // so the second open is refused; its caller reports the failure and stops.
      return Promise.reject(
        new SandboxError("invalid-input", `a session for ${profile.nick} in this session directory is already being opened`),
      );
    }
    const attempt = this.openSandboxSession(launcher, key, profile, opts).finally(() => {
      if (this.opening.get(key) === attempt) this.opening.delete(key);
    });
    this.opening.set(key, attempt);
    return attempt;
  }

  private refusedAfterDispose(): Error {
    return new Error("agent harness is shutting down: openSession refused");
  }

  private async openHostSession(
    profile: AgentProfile,
    opts: { readonly cwd: string; readonly onPermission: PermissionHandler },
  ): Promise<HarnessSession> {
    const proc = this.ensureProc(profile, buildSpawnSpec(profile, this.opts.config, this.opts.baseEnv, this.opts.extraEnv?.()), profile.nick);
    await proc.ready;
    return this.newSession(proc, profile, opts);
  }

  /** `session/new` in a ready process, with the S8 profile check. */
  private async newSession(
    proc: Proc,
    profile: AgentProfile,
    opts: { readonly cwd: string; readonly onPermission: PermissionHandler },
  ): Promise<AcpSession> {
    const res = await proc.client.request("session/new", { cwd: opts.cwd, mcpServers: [] });
    const sessionId = res["sessionId"];
    if (typeof sessionId !== "string" || sessionId === "") {
      throw new Error("session/new result has no string sessionId");
    }
    // Fail closed: Kiro silently falls back to kiro_default when the agent file is not loaded (S8).
    const actual = asStr(asObj(res["modes"])?.["currentModeId"]);
    if (actual !== profile.kiroAgent) {
      this.opts.logger.error("agent profile not loaded, terminating process", {
        agent: profile.nick,
        kiroAgent: profile.kiroAgent,
        actualModeId: actual,
      });
      if (proc.containerName !== undefined) await this.retireContainer(proc).catch(() => undefined);
      else await this.terminate(profile, "SIGTERM");
      throw new AgentProfileNotLoadedError(profile.kiroAgent, actual);
    }
    const session = new AcpSession(sessionId, proc, this, opts.onPermission);
    proc.sessions.set(sessionId, session);
    return session;
  }

  /**
   * Podman mode (Requirements 3.5, 8, 10, 11): quick checks, one container per (agent, cwd), a start
   * budget, and on any failure the container is removed and a `SandboxError` thrown. Never falls
   * back to a host process (3.6).
   */
  private async openSandboxSession(
    launcher: PodmanLauncher,
    key: string,
    profile: AgentProfile,
    opts: { readonly cwd: string; readonly onPermission: PermissionHandler },
  ): Promise<HarnessSession> {
    await launcher.quickCheck();
    if (this.disposing) throw this.refusedAfterDispose();
    // A container of this pair that is still registered has not been retired, whatever it holds.
    if (this.procs.has(key)) {
      throw new SandboxError("invalid-input", `${profile.nick} already has a container for this session directory`);
    }
    const spec = await buildSandboxSpawnSpec(launcher, profile, opts.cwd, this.opts.extraEnv?.());
    if (this.disposing) {
      // The spec registered a name but no container exists yet: forget it before refusing.
      await launcher.remove(spec.containerName).catch(() => undefined);
      throw this.refusedAfterDispose();
    }
    if (this.procs.has(key)) {
      await launcher.remove(spec.containerName).catch(() => undefined);
      throw new SandboxError("invalid-input", `${profile.nick} already has a container for this session directory`);
    }
    // From here to `ensureProc` there is no await: dispose() either sees this container or this
    // open has already been refused above.
    const proc = this.ensureProc(profile, spec, key, spec.containerName);
    const budget = this.opts.startTimeoutMs ?? DEFAULT_SANDBOX_START_TIMEOUT_MS;
    let timer: TimerHandle | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = this.opts.clock.setTimeout(() => {
        reject(new SandboxError("start-timeout", `container start timed out after ${budget} ms`));
      }, budget);
    });
    try {
      const session = await Promise.race([
        proc.ready.then(
          () => this.newSession(proc, profile, opts),
          (err: unknown) => {
            throw new SandboxError(
              "start-failed",
              `container failed to start: ${errText(err)}`,
              scrubDetail(proc.client.lastStderrLine, [this.opts.config.kiroApiKey]),
            );
          },
        ),
        timeout,
      ]);
      // Review finding 3: a session that came up while dispose() ran is not handed out.
      if (this.disposing) throw this.refusedAfterDispose();
      return session;
    } catch (err) {
      await this.retireContainer(proc).catch((removeErr: unknown) => {
        this.opts.logger.error("container removal after a failed start failed", {
          agent: profile.nick,
          error: errText(removeErr),
        });
      });
      if (this.disposing || err instanceof SandboxError || err instanceof AgentProfileNotLoadedError) throw err;
      throw new SandboxError("start-failed", `container failed to start: ${errText(err)}`, scrubDetail(proc.client.lastStderrLine));
    } finally {
      if (timer !== undefined) this.opts.clock.clearTimeout(timer);
    }
  }

  /**
   * Podman mode: stops the `podman run` client and removes its container by name (the name-based
   * `stop` / `rm` is authoritative, Requirement 10.6). Memoised; rejects when the removal failed.
   */
  retireContainer(proc: Proc): Promise<void> {
    const launcher = this.opts.sandbox;
    const name = proc.containerName;
    if (launcher === undefined || name === undefined) return Promise.resolve();
    if (this.procs.get(proc.key) === proc) this.procs.delete(proc.key);
    proc.removal ??= (async (): Promise<void> => {
      this.disarm(proc);
      await proc.client.close().catch((err: unknown) => {
        this.opts.logger.warn("podman client close failed", { container: name, error: errText(err) });
      });
      await launcher.remove(name);
    })();
    return proc.removal;
  }

  /** Every process of an agent: one in `none` mode, one per container in podman mode. */
  private procsOf(profile: AgentProfile): readonly Proc[] {
    const nick = irc_lower(profile.nick);
    return [...this.procs.values()].filter((p) => irc_lower(p.profile.nick) === nick);
  }

  async terminate(profile: AgentProfile, signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): Promise<void> {
    if (this.opts.sandbox !== undefined) {
      // Requirement 8.2: every container of the agent; removal by name follows the kill.
      await Promise.all(
        this.procsOf(profile).map(async (proc) => {
          await this.killWithEscalation(proc, signal);
          await this.retireContainer(proc).catch((err: unknown) => {
            this.opts.logger.error("container removal failed", { agent: profile.nick, error: errText(err) });
          });
        }),
      );
      return;
    }
    const proc = this.procs.get(profile.nick);
    if (proc === undefined) return;
    await this.killWithEscalation(proc, signal);
  }

  /** Sends `signal` to the process group; a SIGTERM that is ignored is followed by SIGKILL after killGraceMs. */
  private async killWithEscalation(proc: Proc, signal: "SIGTERM" | "SIGKILL"): Promise<void> {
    const exited = proc.client.kill(signal);
    if (signal === "SIGKILL") {
      await exited;
      return;
    }
    const agent = proc.profile.nick;
    const timer = this.opts.clock.setTimeout(() => {
      this.opts.logger.warn("agent ignored SIGTERM, sending SIGKILL", { agent });
      void proc.client.kill("SIGKILL").catch((err: unknown) => {
        this.opts.logger.error("SIGKILL of agent failed", { agent, error: errText(err) });
      });
    }, this.opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    try {
      await exited;
    } finally {
      this.opts.clock.clearTimeout(timer);
    }
  }

  onProcessEvent(listener: (e: ProcessEvent) => void): Unsubscribe {
    this.processListeners.add(listener);
    return () => {
      this.processListeners.delete(listener);
    };
  }

  hasProcess(profile: AgentProfile): boolean {
    if (this.opts.sandbox !== undefined) return this.procsOf(profile).some((p) => p.client.running);
    return this.procs.get(profile.nick)?.client.running === true;
  }

  async dispose(): Promise<void> {
    // Review finding 3: from here on openSession rejects. Every container an open in flight has
    // created is in `procs` (ensureProc runs without an await after the last check), so it is
    // closed and retired below; an open still in its pre-flight checks is refused when it resumes.
    this.disposing = true;
    const procs = [...this.procs.values()];
    for (const p of procs) this.disarm(p);
    await Promise.all(procs.map((p) => p.client.close()));
    const launcher = this.opts.sandbox;
    if (launcher === undefined) return;
    // Requirement 10.2, 10.4: every container of this run is removed, then a label sweep.
    await Promise.all(
      procs.map((p) =>
        this.retireContainer(p).catch((err: unknown) => {
          this.opts.logger.error("container removal at shutdown failed", { agent: p.profile.nick, error: errText(err) });
        }),
      ),
    );
    // Opens in flight settle (refused or failed) before the final sweep, so nothing they started
    // is left behind when dispose() resolves.
    await Promise.allSettled([...this.opening.values()]);
    await Promise.all(
      [...this.procs.values()].map((p) =>
        this.retireContainer(p).catch((err: unknown) => {
          this.opts.logger.error("container removal at shutdown failed", { agent: p.profile.nick, error: errText(err) });
        }),
      ),
    );
    await launcher.sweep();
  }

  // --- hung-agent watchdog (Req 9.12, 9.13) ---

  /** A Turn started in `proc`; the first Turn of the process arms the watchdog. */
  turnStarted(proc: Proc): void {
    proc.inFlight += 1;
    if (proc.inFlight === 1) this.arm(proc);
  }

  /** A Turn ended (resolved or rejected) in `proc`; no Turn in flight disarms the watchdog. */
  turnEnded(proc: Proc): void {
    proc.inFlight = Math.max(0, proc.inFlight - 1);
    if (proc.inFlight === 0) this.disarm(proc);
  }

  /** Any frame arrived from `proc` (valid or not): re-arm while a Turn is in flight. */
  private frameSeen(proc: Proc): void {
    if (proc.inFlight > 0) this.arm(proc);
  }

  private arm(proc: Proc): void {
    this.disarm(proc);
    const ms = this.opts.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS;
    proc.watchdog = this.opts.clock.setTimeout(() => this.onHung(proc), ms);
  }

  private disarm(proc: Proc): void {
    if (proc.watchdog === undefined) return;
    this.opts.clock.clearTimeout(proc.watchdog);
    proc.watchdog = undefined;
  }

  private onHung(proc: Proc): void {
    proc.watchdog = undefined;
    const agent = proc.profile.nick;
    this.opts.logger.error("agent hung, sending SIGTERM", {
      agent,
      timeoutMs: this.opts.promptTimeoutMs ?? DEFAULT_PROMPT_TIMEOUT_MS,
    });
    this.emitProcess({ kind: "hung", agent, sessionIds: [...proc.sessions.keys()] });
    // The client rejects every pending request (including each session/prompt) when the process exits.
    void this.killWithEscalation(proc, "SIGTERM").catch((err: unknown) => {
      this.opts.logger.error("SIGTERM of hung agent failed", { agent, error: errText(err) });
    });
  }

  // --- internals ---

  private emitProcess(e: ProcessEvent): void {
    for (const l of [...this.processListeners]) l(e);
  }

  private ensureProc(profile: AgentProfile, spec: SpawnSpec, key: string, containerName?: string): Proc {
    const existing = this.procs.get(key);
    if (existing !== undefined && containerName === undefined) return existing;

    const clientOptions: AcpClientOptions = {
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      env: spec.env,
      logger: this.opts.logger,
      clock: this.opts.clock,
    };
    const client = this.opts.createClient?.(clientOptions) ?? new AcpClient(clientOptions);
    const proc: Proc = {
      profile,
      client,
      sessions: new Map(),
      inFlight: 0,
      ready: Promise.resolve(),
      key,
      ...(containerName !== undefined ? { containerName } : {}),
    };
    this.procs.set(key, proc);

    client.onNotification((method, params) => this.onNotification(proc, method, params));
    client.onActivity(() => this.frameSeen(proc));
    client.handle("session/request_permission", (req) => this.onPermission(proc, req.params));

    // No `fs` capability is advertised: Kiro writes files itself (Req 8.1).
    const init = client.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    // The process was spawned synchronously by `request`, so `exited` belongs to it.
    void client.exited.then((info) => this.onExit(proc, info.code, info.signal));
    proc.ready = init.then(
      () => undefined,
      (err: unknown) => {
        this.opts.logger.error("acp initialize failed", { agent: profile.nick, error: errText(err) });
        throw err instanceof Error ? err : new Error(String(err));
      },
    );
    // Avoid an unhandled rejection when nobody awaits `ready`.
    proc.ready.catch(() => undefined);
    return proc;
  }

  private onExit(proc: Proc, code: number | null, signal: NodeJS.Signals | null): void {
    this.disarm(proc);
    proc.inFlight = 0;
    if (this.procs.get(proc.key) === proc) this.procs.delete(proc.key);
    const sessionIds = [...proc.sessions.keys()];
    for (const s of proc.sessions.values()) s.markClosed();
    proc.sessions.clear();
    if (proc.containerName === undefined) {
      this.emitProcess({ kind: "exited", agent: proc.profile.nick, code, signal });
      return;
    }
    // Podman mode: an exit (crash, hung kill, `--timeout`) removes the container too (Requirement
    // 10.2, 10.5); the event names only this container's sessions (8.3).
    this.retireContainer(proc).catch((err: unknown) => {
      this.opts.logger.error("container removal after exit failed", { agent: proc.profile.nick, error: errText(err) });
    });
    this.emitProcess({ kind: "exited", agent: proc.profile.nick, code, signal, sessionIds });
  }

  private onNotification(proc: Proc, method: string, params: JsonObject): void {
    const sessionId = asStr(params["sessionId"]);
    const session = sessionId === undefined ? undefined : proc.sessions.get(sessionId);
    if (method !== "session/update" && method !== "_kiro.dev/metadata") {
      this.opts.logger.debug("acp notification ignored", { method });
      return;
    }
    if (session === undefined) {
      this.opts.logger.debug("acp notification for unknown session dropped", { method, sessionId });
      return;
    }
    if (method === "_kiro.dev/metadata") {
      const turn = params["turnDurationMs"];
      const usage = params["meteringUsage"];
      const metering: readonly unknown[] = Array.isArray(usage) ? (usage as readonly unknown[]) : [];
      session.emit(
        typeof turn === "number" && Number.isFinite(turn)
          ? { kind: "metadata", turnDurationMs: turn, metering }
          : { kind: "metadata", metering },
      );
      return;
    }
    const update = asObj(params["update"]) ?? {};
    const type = asStr(update["sessionUpdate"]) ?? "";
    const text = asStr(asObj(update["content"])?.["text"]) ?? "";
    switch (type) {
      case "agent_message_chunk":
        session.emit({ kind: "message-chunk", text });
        return;
      case "agent_thought_chunk":
        session.emit({ kind: "thought-chunk", text });
        return;
      case "tool_call": {
        const id = asStr(update["toolCallId"]);
        const tool = resolveTool(update, id === undefined ? undefined : session.tools.get(id));
        if (id !== undefined) session.tools.record(id, update);
        session.emit({ kind: "tool-call", tool });
        return;
      }
      case "tool_call_update": {
        // Real kiro sends kind and paths here and in `tool_call`, not in the permission request.
        const id = asStr(update["toolCallId"]);
        if (id !== undefined) session.tools.record(id, update);
        session.emit({ kind: "unknown", sessionUpdate: type });
        return;
      }
      default:
        session.emit({ kind: "unknown", sessionUpdate: type });
    }
  }

  private async onPermission(proc: Proc, params: JsonObject): Promise<JsonObject> {
    const sessionId = asStr(params["sessionId"]);
    const session = sessionId === undefined ? undefined : proc.sessions.get(sessionId);
    const rawOptions = params["options"];
    if (session === undefined || !Array.isArray(rawOptions) || asObj(params["toolCall"]) === undefined) {
      this.opts.logger.warn("permission request malformed or for unknown session, cancelled", { sessionId });
      return CANCELLED;
    }
    const options: { id: string; kind: string }[] = [];
    for (const o of rawOptions as readonly Json[]) {
      const id = asStr(asObj(o)?.["optionId"]);
      const kind = asStr(asObj(o)?.["kind"]);
      if (id !== undefined && kind !== undefined) options.push({ id, kind });
    }
    const toolCall = asObj(params["toolCall"]) ?? {};
    const toolCallId = asStr(toolCall["toolCallId"]);
    const tool = resolveTool(toolCall, toolCallId === undefined ? undefined : session.tools.get(toolCallId));
    const answer = await session.onPermission({ tool, options });
    if ("cancelled" in answer) return CANCELLED;
    const chosen = options.find((o) => o.kind === answer.decision);
    if (chosen === undefined) {
      this.opts.logger.warn("permission option missing, cancelled", { decision: answer.decision });
      return CANCELLED;
    }
    return { outcome: { outcome: "selected", optionId: chosen.id } };
  }
}
