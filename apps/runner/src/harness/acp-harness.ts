/**
 * AcpHarness: one `kiro-cli acp` process per Agent, one ACP session per channel.
 * Everything the agent sends is untrusted and is validated at this boundary (Req 2.11, 8.9, 8.10).
 */
import { AcpClient, type JsonObject } from "../acp/client.js";
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
  ToolInfo,
  TurnResult,
} from "./harness.js";
import { buildSpawnSpec } from "./spawn.js";

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
}

const DEFAULT_PROMPT_TIMEOUT_MS = 120_000;
const DEFAULT_KILL_GRACE_MS = 5000;

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

function extractTool(raw: Json | undefined): ToolInfo {
  const o = asObj(raw) ?? {};
  const rawInput = asObj(o["rawInput"]) ?? {};
  const paths: string[] = [];
  const p = asStr(rawInput["path"]);
  if (p !== undefined) paths.push(p);
  const locations = o["locations"];
  if (Array.isArray(locations)) {
    for (const loc of locations as readonly Json[]) {
      const lp = asStr(asObj(loc)?.["path"]);
      if (lp !== undefined) paths.push(lp);
    }
  }
  const base = { kind: asStr(o["kind"]) ?? "other", title: asStr(o["title"]) ?? "", paths };
  const command = asStr(rawInput["command"]);
  return command === undefined ? base : { ...base, command };
}

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
}

class AcpSession implements HarnessSession {
  readonly id: string;
  readonly onPermission: PermissionHandler;
  private readonly listeners = new Set<(e: SessionEvent) => void>();
  private readonly proc: Proc;
  private readonly harness: AcpHarness;
  private closed = false;

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

  constructor(opts: AcpHarnessOptions) {
    this.opts = opts;
  }

  async openSession(
    profile: AgentProfile,
    opts: { readonly cwd: string; readonly onPermission: PermissionHandler },
  ): Promise<HarnessSession> {
    const proc = this.ensureProc(profile);
    await proc.ready;
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
      await this.terminate(profile, "SIGTERM");
      throw new AgentProfileNotLoadedError(profile.kiroAgent, actual);
    }
    const session = new AcpSession(sessionId, proc, this, opts.onPermission);
    proc.sessions.set(sessionId, session);
    return session;
  }

  async terminate(profile: AgentProfile, signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): Promise<void> {
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
    return this.procs.get(profile.nick)?.client.running === true;
  }

  async dispose(): Promise<void> {
    const procs = [...this.procs.values()];
    for (const p of procs) this.disarm(p);
    await Promise.all(procs.map((p) => p.client.close()));
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

  private ensureProc(profile: AgentProfile): Proc {
    const existing = this.procs.get(profile.nick);
    if (existing !== undefined) return existing;

    const spec = buildSpawnSpec(profile, this.opts.config, this.opts.baseEnv, this.opts.extraEnv?.());
    const client = new AcpClient({
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      env: spec.env,
      logger: this.opts.logger,
      clock: this.opts.clock,
    });
    const proc: Proc = { profile, client, sessions: new Map(), inFlight: 0, ready: Promise.resolve() };
    this.procs.set(profile.nick, proc);

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
    if (this.procs.get(proc.profile.nick) === proc) this.procs.delete(proc.profile.nick);
    for (const s of proc.sessions.values()) s.markClosed();
    proc.sessions.clear();
    this.emitProcess({ kind: "exited", agent: proc.profile.nick, code, signal });
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
      case "tool_call":
        session.emit({ kind: "tool-call", tool: extractTool(update) });
        return;
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
    const answer = await session.onPermission({ tool: extractTool(params["toolCall"]), options });
    if ("cancelled" in answer) return CANCELLED;
    const chosen = options.find((o) => o.kind === answer.decision);
    if (chosen === undefined) {
      this.opts.logger.warn("permission option missing, cancelled", { decision: answer.decision });
      return CANCELLED;
    }
    return { outcome: { outcome: "selected", optionId: chosen.id } };
  }
}
