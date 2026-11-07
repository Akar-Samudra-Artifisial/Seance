// FakeHarness: an in-process AgentHarness on top of FakeAgentCore. No child process, no wall clock.
//
// It talks to the core with the same JSON-RPC lines the real AcpHarness would use, so the
// Fake_Agent's cancel-then-reuse race, scripted permissions and metadata all behave as on the wire.
// Tests drive it through `advance(ms)` (virtual time), `release(agent, gate)`, the permission handler
// they pass to `openSession`, and `simulateHung` / `simulateExit` (process events).
import type {
  AgentHarness,
  HarnessSession,
  PermissionAnswer,
  PermissionHandler,
  PermissionRequest,
  ProcessEvent,
  SessionEvent,
  ToolInfo,
  TurnResult,
} from "../../src/harness/harness.js";
import type { Unsubscribe } from "../../src/ports.js";
import type { AgentProfile } from "../../src/registry/agent-profile.js";
import { FakeAgentCore } from "./fake-agent.js";
import type { FakeScript, RpcId } from "./fake-agent.js";

export type RecordedPrompt = {
  readonly agent: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly text: string;
};

export type RecordedCancel = {
  readonly agent: string;
  readonly sessionId: string;
  /** True when a prompt was in flight on the session at the time. */
  readonly inFlight: boolean;
};

export type FakeHarnessOptions = {
  /** Scripts by profile nick; agents without an entry use `defaultScript`. */
  readonly scripts?: Readonly<Record<string, FakeScript>>;
  readonly defaultScript?: FakeScript;
};

type Obj = Readonly<Record<string, unknown>>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is RpcId => typeof v === "number" || typeof v === "string";

type Pending = {
  readonly sessionId: string | undefined;
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
};

type SessionRec = {
  readonly id: string;
  readonly cwd: string;
  readonly onPermission: PermissionHandler;
  readonly listeners: Set<(e: SessionEvent) => void>;
  inFlight: boolean;
  closed: boolean;
};

type Proc = {
  readonly agent: string;
  readonly core: FakeAgentCore;
  readonly pending: Map<string, Pending>;
  readonly sessions: Map<string, SessionRec>;
  alive: boolean;
};

const toolInfo = (raw: unknown): ToolInfo => {
  const tc = isObj(raw) ? raw : {};
  const rawInput = isObj(tc["rawInput"]) ? tc["rawInput"] : {};
  const paths: string[] = [];
  if (typeof rawInput["path"] === "string") paths.push(rawInput["path"]);
  if (Array.isArray(tc["locations"])) {
    for (const loc of tc["locations"] as readonly unknown[]) {
      if (isObj(loc) && typeof loc["path"] === "string") paths.push(loc["path"]);
    }
  }
  const base = {
    kind: typeof tc["kind"] === "string" ? tc["kind"] : "other",
    title: typeof tc["title"] === "string" ? tc["title"] : "",
    paths,
  };
  return typeof rawInput["command"] === "string" ? { ...base, command: rawInput["command"] } : base;
};

export class FakeHarness implements AgentHarness {
  /** Every `session/prompt` sent to an agent, in order. */
  readonly prompts: RecordedPrompt[] = [];
  /** Every `session/cancel` sent to an agent, in order. */
  readonly cancels: RecordedCancel[] = [];
  /** Every `terminate` call. */
  readonly terminations: { readonly agent: string; readonly signal: "SIGTERM" | "SIGKILL" }[] = [];

  private readonly options: FakeHarnessOptions;
  private readonly procs = new Map<string, Proc>();
  private readonly spawns = new Map<string, number>();
  private readonly processListeners = new Set<(e: ProcessEvent) => void>();
  private nextId = 1;

  constructor(options: FakeHarnessOptions = {}) {
    this.options = options;
  }

  // ---- AgentHarness -------------------------------------------------------------------------

  async openSession(
    profile: AgentProfile,
    opts: { readonly cwd: string; readonly onPermission: PermissionHandler },
  ): Promise<HarnessSession> {
    const proc = this.ensureProc(profile);
    const result = await this.request(proc, "session/new", { cwd: opts.cwd, mcpServers: [] }, undefined);
    const sessionId = isObj(result) ? result["sessionId"] : undefined;
    if (typeof sessionId !== "string") {
      throw new Error(`FakeHarness: session/new for ${profile.nick} returned no sessionId`);
    }
    const rec: SessionRec = {
      id: sessionId,
      cwd: opts.cwd,
      onPermission: opts.onPermission,
      listeners: new Set(),
      inFlight: false,
      closed: false,
    };
    proc.sessions.set(sessionId, rec);
    return {
      id: sessionId,
      prompt: (text) => this.prompt(proc, rec, text),
      cancel: () => this.cancel(proc, rec),
      close: async () => {
        rec.closed = true;
        proc.sessions.delete(sessionId);
      },
      onEvent: (listener): Unsubscribe => {
        rec.listeners.add(listener);
        return () => {
          rec.listeners.delete(listener);
        };
      },
    };
  }

  async terminate(profile: AgentProfile, signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): Promise<void> {
    this.terminations.push({ agent: profile.nick, signal });
    const proc = this.procs.get(profile.nick);
    if (proc !== undefined) this.exit(proc, null, signal);
  }

  onProcessEvent(listener: (e: ProcessEvent) => void): Unsubscribe {
    this.processListeners.add(listener);
    return () => {
      this.processListeners.delete(listener);
    };
  }

  hasProcess(profile: AgentProfile): boolean {
    return this.procs.get(profile.nick)?.alive === true;
  }

  async dispose(): Promise<void> {
    for (const proc of [...this.procs.values()]) this.exit(proc, null, "SIGTERM");
  }

  // ---- test controls ------------------------------------------------------------------------

  /** Number of processes spawned for the agent so far. */
  spawnCount(agent: string): number {
    return this.spawns.get(agent) ?? 0;
  }

  /** The live Fake_Agent core of an agent (for `dump()` and `virtualNow`). */
  coreOf(agent: string): FakeAgentCore | undefined {
    const proc = this.procs.get(agent);
    return proc?.alive === true ? proc.core : undefined;
  }

  /** Advances the virtual clock of every live agent by `ms` and delivers what fires. */
  advance(ms: number): void {
    for (const proc of [...this.procs.values()]) {
      if (proc.alive) this.pump(proc, proc.core.advance(ms));
    }
  }

  /** Releases a scripted `gate` step on an agent. */
  release(agent: string, gate: string): void {
    const proc = this.procs.get(agent);
    if (proc === undefined || !proc.alive) throw new Error(`FakeHarness: no live process for agent "${agent}"`);
    this.pump(proc, proc.core.handleLine(JSON.stringify({
      jsonrpc: "2.0",
      id: this.nextId++,
      method: "fake/release",
      params: { name: gate },
    })));
  }

  /**
   * Mimics the watchdog: emits `hung` with the sessions that have a prompt in flight, rejects
   * every pending prompt, then ends the process with SIGTERM (so `exited` follows).
   */
  simulateHung(agent: string): void {
    const proc = this.liveProc(agent);
    const sessionIds = [...proc.sessions.values()].filter((s) => s.inFlight).map((s) => s.id);
    this.emitProcess({ kind: "hung", agent, sessionIds });
    this.exit(proc, null, "SIGTERM");
  }

  /** Ends the agent process as if it had exited by itself. */
  simulateExit(agent: string, code: number | null = 1, signal: NodeJS.Signals | null = null): void {
    this.exit(this.liveProc(agent), code, signal);
  }

  // ---- internals ----------------------------------------------------------------------------

  private liveProc(agent: string): Proc {
    const proc = this.procs.get(agent);
    if (proc === undefined || !proc.alive) throw new Error(`FakeHarness: no live process for agent "${agent}"`);
    return proc;
  }

  private ensureProc(profile: AgentProfile): Proc {
    const existing = this.procs.get(profile.nick);
    if (existing?.alive === true) return existing;
    const script = this.options.scripts?.[profile.nick] ?? this.options.defaultScript;
    const core = new FakeAgentCore({
      agentName: profile.kiroAgent,
      ...(script !== undefined ? { script } : {}),
    });
    const proc: Proc = { agent: profile.nick, core, pending: new Map(), sessions: new Map(), alive: true };
    this.procs.set(profile.nick, proc);
    this.spawns.set(profile.nick, (this.spawns.get(profile.nick) ?? 0) + 1);
    // initialize is answered synchronously by the core; its result is not needed.
    // An exit during initialize (script `initExitCode`) surfaces as an `exited` event and a failed openSession.
    this.request(proc, "initialize", { protocolVersion: 1, clientCapabilities: {} }, undefined).catch(() => undefined);
    return proc;
  }

  private request(proc: Proc, method: string, params: Obj, sessionId: string | undefined): Promise<unknown> {
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      proc.pending.set(String(id), { sessionId, resolve, reject });
    });
    this.pump(proc, proc.core.handleLine(JSON.stringify({ jsonrpc: "2.0", id, method, params })));
    return promise;
  }

  private prompt(proc: Proc, rec: SessionRec, text: string): Promise<TurnResult> {
    if (!proc.alive || rec.closed) {
      return Promise.reject(new Error(`FakeHarness: session ${rec.id} of ${proc.agent} is not open`));
    }
    this.prompts.push({ agent: proc.agent, sessionId: rec.id, cwd: rec.cwd, text });
    rec.inFlight = true;
    const result = this.request(proc, "session/prompt", {
      sessionId: rec.id,
      prompt: [{ type: "text", text }],
    }, rec.id);
    return result.then(
      (r): TurnResult => {
        rec.inFlight = false;
        const stopReason = isObj(r) && typeof r["stopReason"] === "string" ? r["stopReason"] : "end_turn";
        return { stopReason };
      },
      (e: unknown) => {
        rec.inFlight = false;
        throw e;
      },
    );
  }

  private cancel(proc: Proc, rec: SessionRec): void {
    if (!proc.alive) return;
    this.cancels.push({ agent: proc.agent, sessionId: rec.id, inFlight: rec.inFlight });
    this.pump(proc, proc.core.handleLine(JSON.stringify({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: rec.id },
    })));
  }

  /** Delivers the lines the core produced, then notices a scripted crash. */
  private pump(proc: Proc, lines: readonly string[]): void {
    for (const line of lines) this.deliver(proc, line);
    const code = proc.core.exitCode;
    if (code !== undefined && proc.alive) this.exit(proc, code, null);
  }

  private deliver(proc: Proc, line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      throw new Error(`FakeHarness: Fake_Agent emitted a non-JSON line: ${String(e)}`);
    }
    if (!isObj(msg)) return;
    const id = msg["id"];
    const method = msg["method"];
    if (typeof method !== "string") {
      if (!isId(id)) return;
      const pending = proc.pending.get(String(id));
      if (pending === undefined) return;
      proc.pending.delete(String(id));
      if (isObj(msg["error"])) {
        const m = msg["error"]["message"];
        pending.reject(new Error(typeof m === "string" ? m : "JSON-RPC error"));
      } else {
        pending.resolve(msg["result"]);
      }
      return;
    }
    const params = isObj(msg["params"]) ? msg["params"] : {};
    const sessionId = typeof params["sessionId"] === "string" ? params["sessionId"] : undefined;
    const rec = sessionId !== undefined ? proc.sessions.get(sessionId) : undefined;
    if (rec === undefined) return;
    if (method === "session/update") {
      this.emit(rec, this.mapUpdate(params["update"]));
    } else if (method === "_kiro.dev/metadata") {
      const metering = Array.isArray(params["meteringUsage"]) ? (params["meteringUsage"] as readonly unknown[]) : [];
      const turnDurationMs = params["turnDurationMs"];
      this.emit(rec, {
        kind: "metadata",
        metering,
        ...(typeof turnDurationMs === "number" ? { turnDurationMs } : {}),
      });
    } else if (method === "session/request_permission" && isId(id)) {
      void this.answerPermission(proc, rec, id, params);
    }
  }

  private mapUpdate(update: unknown): SessionEvent {
    const u = isObj(update) ? update : {};
    const kind = typeof u["sessionUpdate"] === "string" ? u["sessionUpdate"] : "";
    const content = isObj(u["content"]) ? u["content"] : {};
    const text = typeof content["text"] === "string" ? content["text"] : "";
    switch (kind) {
      case "agent_message_chunk":
        return { kind: "message-chunk", text };
      case "agent_thought_chunk":
        return { kind: "thought-chunk", text };
      case "tool_call":
        return { kind: "tool-call", tool: toolInfo(u) };
      default:
        return { kind: "unknown", sessionUpdate: kind };
    }
  }

  private emit(rec: SessionRec, event: SessionEvent): void {
    for (const listener of [...rec.listeners]) listener(event);
  }

  private async answerPermission(proc: Proc, rec: SessionRec, id: RpcId, params: Obj): Promise<void> {
    const options = (Array.isArray(params["options"]) ? (params["options"] as readonly unknown[]) : [])
      .filter(isObj)
      .flatMap((o) =>
        typeof o["optionId"] === "string" && typeof o["kind"] === "string"
          ? [{ id: o["optionId"], kind: o["kind"] }]
          : [],
      );
    const req: PermissionRequest = { tool: toolInfo(params["toolCall"]), options };
    let answer: PermissionAnswer;
    try {
      answer = await rec.onPermission(req);
    } catch {
      answer = { cancelled: true };
    }
    if (!proc.alive) return;
    const chosen = "decision" in answer ? options.find((o) => o.kind === answer.decision) : undefined;
    const outcome = chosen !== undefined
      ? { outcome: "selected", optionId: chosen.id }
      : { outcome: "cancelled" };
    this.pump(proc, proc.core.handleLine(JSON.stringify({ jsonrpc: "2.0", id, result: { outcome } })));
  }

  private exit(proc: Proc, code: number | null, signal: NodeJS.Signals | null): void {
    if (!proc.alive) return;
    proc.alive = false;
    const why = signal !== null ? `signal ${signal}` : `exit code ${String(code)}`;
    for (const pending of [...proc.pending.values()]) {
      pending.reject(new Error(`${proc.agent} exited: ${why}`));
    }
    proc.pending.clear();
    for (const rec of proc.sessions.values()) rec.inFlight = false;
    this.emitProcess({ kind: "exited", agent: proc.agent, code, signal });
  }

  private emitProcess(event: ProcessEvent): void {
    for (const listener of [...this.processListeners]) listener(event);
  }
}
