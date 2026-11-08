// Fake_Agent: a scriptable stand-in for `kiro-cli acp` (newline-delimited JSON-RPC 2.0 on stdio).
//
// `FakeAgentCore` is a pure state machine with a virtual clock: it never reads the wall clock,
// never touches I/O and returns the lines it wants to send. The stdio wrapper at the bottom of
// this file feeds it stdin lines and writes its output to stdout. Node runs this file directly
// (type stripping), so the launcher `fake-kiro` needs no build step.
//
// Environment (wrapper only):
//   FAKE_AGENT_NAME    agent name reported as `modes.currentModeId` (the launcher passes `--agent <name>`)
//   FAKE_AGENT_SCRIPT  inline JSON (starts with `{`) or a path to a JSON file
//   FAKE_AGENT_DUMP_FILE  optional; the latest `fake/dump` state is written there after every input line
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export type RpcId = number | string;

export interface ToolCallSpec {
  readonly kind: string;
  readonly title: string;
  readonly path?: string;
  readonly command?: string;
}

export interface CreditSpec {
  readonly value: number;
  readonly unit: string;
}

export type Step =
  | { readonly chunk: string }
  | { readonly thought: string }
  | { readonly toolCall: ToolCallSpec }
  | { readonly permission: { readonly toolCall: ToolCallSpec; readonly ids?: "string" | "number" } }
  | { readonly metadata: { readonly turnDurationMs?: number; readonly credits?: readonly CreditSpec[] } }
  | { readonly delay: number }
  | { readonly gate: string }
  | { readonly crash: number }
  | { readonly stop: string }
  /**
   * Sandbox suite only (agent-sandbox task 8.3): `status`, `env:NAME,NAME`, `write:/path`,
   * `connect:host:port` or `git`. The core stays pure: the stdio wrapper runs the probe and the
   * result is sent as a message chunk `probe <spec> => <result>`.
   */
  | { readonly probe: string };

export const PROBE_SPEC = /^(?:status|git|env:[A-Z_][A-Z0-9_]*(?:,[A-Z_][A-Z0-9_]*)*|write:(?:@cwd)?\/[^\0]*|connect:[0-9A-Za-z.-]+:[0-9]{1,5})$/;

export interface TurnScript {
  readonly match?: string;
  readonly steps: readonly Step[];
}

export interface FakeScript {
  readonly turns: readonly TurnScript[];
  readonly settleMs?: number;
  readonly initExitCode?: number;
  readonly metadataAfterCancel?: boolean;
  readonly modeId?: string;
  /**
   * `kiro` (default) mirrors kiro-cli 3.x: a `session/update` `tool_call` (kind, locations, rawInput)
   * is sent first and `session/request_permission` carries only toolCallId, title and rawInput.
   * `legacy` sends the old shape: kind and rawInput directly in the request, no earlier update.
   */
  readonly permissionShape?: "kiro" | "legacy";
}

export const MAX_DELAY_MS = 600_000;
export const DEFAULT_SETTLE_MS = 1000;

type Obj = Readonly<Record<string, unknown>>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const fail = (where: string, why: string): never => {
  throw new Error(`invalid FAKE_AGENT_SCRIPT at ${where}: ${why}`);
};

const parseToolCall = (v: unknown, where: string): ToolCallSpec => {
  if (!isObj(v) || typeof v["kind"] !== "string" || typeof v["title"] !== "string") {
    return fail(where, "expected { kind: string, title: string, path?: string, command?: string }");
  }
  const out: { kind: string; title: string; path?: string; command?: string } = {
    kind: v["kind"],
    title: v["title"],
  };
  if (v["path"] !== undefined) {
    if (typeof v["path"] !== "string") return fail(`${where}.path`, "expected string");
    out.path = v["path"];
  }
  if (v["command"] !== undefined) {
    if (typeof v["command"] !== "string") return fail(`${where}.command`, "expected string");
    out.command = v["command"];
  }
  return out;
};

const parseStep = (v: unknown, where: string): Step => {
  if (!isObj(v)) return fail(where, "step must be an object");
  const keys = Object.keys(v);
  const key = keys[0];
  if (keys.length !== 1 || key === undefined) return fail(where, "step must have exactly one key");
  const val = v[key];
  switch (key) {
    case "chunk":
    case "thought":
    case "gate":
    case "stop":
      if (typeof val !== "string") return fail(where, `${key} must be a string`);
      return { [key]: val } as Step;
    case "probe":
      if (typeof val !== "string" || !PROBE_SPEC.test(val)) {
        return fail(where, "probe must be status, git, env:NAMES, write:/path or connect:host:port");
      }
      return { probe: val };
    case "toolCall":
      return { toolCall: parseToolCall(val, `${where}.toolCall`) };
    case "permission": {
      if (!isObj(val)) return fail(where, "permission must be an object");
      const toolCall = parseToolCall(val["toolCall"], `${where}.permission.toolCall`);
      const ids = val["ids"];
      if (ids === undefined) return { permission: { toolCall } };
      if (ids !== "string" && ids !== "number") return fail(where, 'permission.ids must be "string" or "number"');
      return { permission: { toolCall, ids } };
    }
    case "metadata": {
      if (!isObj(val)) return fail(where, "metadata must be an object");
      const out: { turnDurationMs?: number; credits?: readonly CreditSpec[] } = {};
      if (val["turnDurationMs"] !== undefined) {
        if (typeof val["turnDurationMs"] !== "number") return fail(where, "metadata.turnDurationMs must be a number");
        out.turnDurationMs = val["turnDurationMs"];
      }
      const credits = val["credits"];
      if (credits !== undefined) {
        if (!Array.isArray(credits)) return fail(where, "metadata.credits must be an array");
        out.credits = credits.map((c: unknown): CreditSpec => {
          if (!isObj(c) || typeof c["value"] !== "number" || typeof c["unit"] !== "string") {
            return fail(where, "metadata.credits entries must be { value: number, unit: string }");
          }
          return { value: c["value"], unit: c["unit"] };
        });
      }
      return { metadata: out };
    }
    case "delay":
      if (typeof val !== "number" || !Number.isInteger(val) || val < 0 || val > MAX_DELAY_MS) {
        return fail(where, `delay must be an integer from 0 to ${MAX_DELAY_MS}`);
      }
      return { delay: val };
    case "crash":
      if (typeof val !== "number" || !Number.isInteger(val) || val === 0) {
        return fail(where, "crash must be a non-zero integer exit code");
      }
      return { crash: val };
    default:
      return fail(where, `unknown step "${key}"`);
  }
};

/** Validates a script object (the parsed JSON of FAKE_AGENT_SCRIPT). Throws with the failing path. */
export const parseScript = (raw: unknown): FakeScript => {
  if (!isObj(raw)) return fail("$", "script must be an object");
  const turnsRaw = raw["turns"] ?? [];
  if (!Array.isArray(turnsRaw)) return fail("$.turns", "expected array");
  const turns = turnsRaw.map((t: unknown, i): TurnScript => {
    const where = `$.turns[${i}]`;
    if (!isObj(t) || !Array.isArray(t["steps"])) return fail(where, "expected { match?: string, steps: Step[] }");
    const steps = (t["steps"] as readonly unknown[]).map((s, j) => parseStep(s, `${where}.steps[${j}]`));
    const match = t["match"];
    if (match === undefined) return { steps };
    if (typeof match !== "string") return fail(`${where}.match`, "expected string");
    try {
      new RegExp(match);
    } catch (e) {
      return fail(`${where}.match`, `not a valid regular expression (${String(e)})`);
    }
    return { match, steps };
  });
  const out: {
    turns: readonly TurnScript[];
    settleMs?: number;
    initExitCode?: number;
    metadataAfterCancel?: boolean;
    modeId?: string;
    permissionShape?: "kiro" | "legacy";
  } = { turns };
  const shape = raw["permissionShape"];
  if (shape !== undefined) {
    if (shape !== "kiro" && shape !== "legacy") return fail("$.permissionShape", 'expected "kiro" or "legacy"');
    out.permissionShape = shape;
  }
  const settleMs = raw["settleMs"];
  if (settleMs !== undefined) {
    if (typeof settleMs !== "number" || !Number.isInteger(settleMs) || settleMs < 0 || settleMs > MAX_DELAY_MS) {
      return fail("$.settleMs", `expected an integer from 0 to ${MAX_DELAY_MS}`);
    }
    out.settleMs = settleMs;
  }
  const initExitCode = raw["initExitCode"];
  if (initExitCode !== undefined) {
    if (typeof initExitCode !== "number" || !Number.isInteger(initExitCode) || initExitCode === 0) {
      return fail("$.initExitCode", "expected a non-zero integer");
    }
    out.initExitCode = initExitCode;
  }
  const mac = raw["metadataAfterCancel"];
  if (mac !== undefined) {
    if (typeof mac !== "boolean") return fail("$.metadataAfterCancel", "expected boolean");
    out.metadataAfterCancel = mac;
  }
  const modeId = raw["modeId"];
  if (modeId !== undefined) {
    if (typeof modeId !== "string" || modeId === "") return fail("$.modeId", "expected non-empty string");
    out.modeId = modeId;
  }
  return out;
};

/** Reads FAKE_AGENT_SCRIPT: inline JSON when it starts with `{`, otherwise a file path. */
export const loadScript = (spec: string | undefined): FakeScript => {
  if (spec === undefined || spec.trim() === "") return { turns: [] };
  const text = spec.trim().startsWith("{") ? spec : readFileSync(spec, "utf8");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error(`FAKE_AGENT_SCRIPT is not valid JSON: ${String(e)}`);
  }
  return parseScript(json);
};

export interface FakeDump {
  readonly requests: readonly string[];
  readonly promptCount: number;
  readonly prompts: readonly { readonly sessionId: string; readonly text: string }[];
  readonly cancelCount: number;
  readonly cancels: readonly { readonly sessionId: string; readonly inFlight: boolean }[];
  readonly permissionAnswers: readonly { readonly id: RpcId; readonly optionId: string | null }[];
  readonly sessions: readonly string[];
  readonly now: number;
}

interface Session {
  readonly id: string;
  /** `session/new` params.cwd; `@cwd` in a probe spec expands to it. */
  readonly cwd: string;
  settleUntil: number;
  metadataPending: boolean;
  cancelledTurnMs: number;
  poisoned: boolean;
}

interface Turn {
  readonly sessionId: string;
  readonly reqId: RpcId;
  readonly steps: readonly Step[];
  readonly startedAt: number;
  idx: number;
  wakeAt: number | undefined;
  gate: string | undefined;
  permissionId: RpcId | undefined;
}

const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_BUSY = -32000;

const isId = (v: unknown): v is RpcId => typeof v === "number" || typeof v === "string";

const promptText = (params: Obj): string => {
  const prompt = params["prompt"];
  if (!Array.isArray(prompt)) return "";
  return (prompt as readonly unknown[])
    .map((b) => (isObj(b) && typeof b["text"] === "string" ? b["text"] : ""))
    .join("\n");
};

export interface FakeAgentOptions {
  /** Reported as `modes.currentModeId` unless the script sets `modeId`. */
  readonly agentName: string;
  readonly script?: FakeScript;
  /** Runs a `probe` step (stdio wrapper only); absent means "probe unavailable". */
  readonly probe?: (spec: string) => string;
}

export class FakeAgentCore {
  /** Set when the agent wants the process to exit (crash step or initExitCode). */
  exitCode: number | undefined;

  private readonly agentName: string;
  private readonly script: FakeScript;
  private now = 0;
  private sessionCounter = 0;
  private permissionCounter = 0;
  private readonly sessions = new Map<string, Session>();
  private readonly turns = new Map<string, Turn>();
  private readonly usedTurnScripts = new Set<number>();
  private readonly released = new Set<string>();
  private readonly requestLog: string[] = [];
  private readonly prompts: { sessionId: string; text: string }[] = [];
  private readonly cancels: { sessionId: string; inFlight: boolean }[] = [];
  private readonly permissionAnswers: { id: RpcId; optionId: string | null }[] = [];

  private readonly probe: ((spec: string) => string) | undefined;

  constructor(options: FakeAgentOptions) {
    this.agentName = options.agentName;
    this.script = options.script ?? { turns: [] };
    this.probe = options.probe;
  }

  /** Current virtual time in ms. */
  get virtualNow(): number {
    return this.now;
  }

  /** Handles one input line (without its newline) and returns the lines to send, in order. */
  handleLine(line: string): string[] {
    const out: string[] = [];
    if (this.exitCode !== undefined) return out;
    const text = line.trim();
    if (text === "") return out;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch (e) {
      out.push(this.error(null, ERR_PARSE, `parse error: ${e instanceof Error ? e.message : String(e)}`));
      return out;
    }
    if (!isObj(msg) || msg["jsonrpc"] !== "2.0") {
      out.push(this.error(null, ERR_INVALID_REQUEST, 'invalid request: expected a JSON-RPC 2.0 object with "jsonrpc":"2.0"'));
      return out;
    }
    const id = msg["id"];
    const hasId = isId(id);
    if (msg["id"] !== undefined && !hasId) {
      out.push(this.error(null, ERR_INVALID_REQUEST, "invalid request: id must be a number or a string"));
      return out;
    }
    const method = msg["method"];
    if (method === undefined) {
      if (hasId && ("result" in msg || "error" in msg)) {
        this.onClientResponse(id, msg, out);
        return out;
      }
      out.push(this.error(hasId ? id : null, ERR_INVALID_REQUEST, "invalid request: missing method"));
      return out;
    }
    if (typeof method !== "string" || method === "") {
      out.push(this.error(hasId ? id : null, ERR_INVALID_REQUEST, "invalid request: method must be a non-empty string"));
      return out;
    }
    const params = isObj(msg["params"]) ? msg["params"] : {};
    if (!method.startsWith("fake/")) this.requestLog.push(method);
    this.dispatch(method, hasId ? id : undefined, params, out);
    return out;
  }

  /** Advances the virtual clock by `ms`, firing due delays and settles in time order. */
  advance(ms: number): string[] {
    const out: string[] = [];
    if (!Number.isFinite(ms) || ms < 0) return out;
    const target = this.now + ms;
    for (;;) {
      if (this.exitCode !== undefined) return out;
      const next = this.nextEventTime();
      if (next === undefined || next > target) break;
      this.now = Math.max(this.now, next);
      this.fireDue(out);
    }
    this.now = target;
    return out;
  }

  dump(): FakeDump {
    return {
      requests: [...this.requestLog],
      promptCount: this.prompts.length,
      prompts: this.prompts.map((p) => ({ ...p })),
      cancelCount: this.cancels.length,
      cancels: this.cancels.map((c) => ({ ...c })),
      permissionAnswers: this.permissionAnswers.map((a) => ({ ...a })),
      sessions: [...this.sessions.keys()],
      now: this.now,
    };
  }

  // ---- dispatch -----------------------------------------------------------------------------

  private dispatch(method: string, id: RpcId | undefined, params: Obj, out: string[]): void {
    switch (method) {
      case "initialize":
        if (this.script.initExitCode !== undefined) {
          this.exitCode = this.script.initExitCode;
          return;
        }
        this.reply(id, {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: { image: false, audio: false, embeddedContext: false },
            mcpCapabilities: { http: false, sse: false },
          },
          authMethods: [],
          agentInfo: { name: "fake-kiro", title: "Fake Kiro", version: "0.0.0" },
        }, out);
        return;
      case "session/new":
        this.onSessionNew(id, params, out);
        return;
      case "session/prompt":
        this.onPrompt(id, params, out);
        return;
      case "session/cancel":
        this.onCancel(params);
        this.fireDue(out);
        this.reply(id, null, out);
        return;
      case "fake/advance": {
        const ms = params["ms"];
        if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
          this.replyError(id, ERR_INVALID_PARAMS, "fake/advance requires params.ms >= 0", out);
          return;
        }
        out.push(...this.advance(ms));
        this.reply(id, { now: this.now }, out);
        return;
      }
      case "fake/release": {
        const name = params["name"];
        if (typeof name !== "string") {
          this.replyError(id, ERR_INVALID_PARAMS, "fake/release requires params.name (string)", out);
          return;
        }
        this.released.add(name);
        for (const turn of [...this.turns.values()]) {
          if (turn.gate === name) {
            turn.gate = undefined;
            this.run(turn, out);
          }
        }
        this.reply(id, null, out);
        return;
      }
      case "fake/dump":
        this.reply(id, this.dump(), out);
        return;
      default:
        this.replyError(id, ERR_METHOD_NOT_FOUND, `method not found: ${method}`, out);
    }
  }

  private onSessionNew(id: RpcId | undefined, params: Obj, out: string[]): void {
    if (typeof params["cwd"] !== "string" || params["cwd"] === "") {
      this.replyError(id, ERR_INVALID_PARAMS, "session/new requires params.cwd (string)", out);
      return;
    }
    this.sessionCounter += 1;
    const sessionId = `fake-session-${this.sessionCounter}`;
    this.sessions.set(sessionId, {
      id: sessionId,
      cwd: params["cwd"],
      settleUntil: 0,
      metadataPending: false,
      cancelledTurnMs: 0,
      poisoned: false,
    });
    const currentModeId = this.script.modeId ?? this.agentName;
    const modeIds = [...new Set([currentModeId, this.agentName, "kiro_default"])];
    this.reply(id, {
      sessionId,
      modes: {
        currentModeId,
        availableModes: modeIds.map((m) => ({ id: m, name: m, description: `Fake mode ${m}` })),
      },
      models: {
        currentModelId: "fake-model",
        availableModels: [{ modelId: "fake-model", name: "fake-model", description: "Fake model" }],
      },
    }, out);
  }

  private onPrompt(id: RpcId | undefined, params: Obj, out: string[]): void {
    const sessionId = params["sessionId"];
    const session = typeof sessionId === "string" ? this.sessions.get(sessionId) : undefined;
    if (id === undefined || session === undefined || typeof sessionId !== "string") {
      this.replyError(id, ERR_INVALID_PARAMS, "session/prompt requires a request id and a known params.sessionId", out);
      return;
    }
    const text = promptText(params);
    this.prompts.push({ sessionId, text });
    if (this.turns.has(sessionId)) {
      this.replyError(id, ERR_BUSY, `session ${sessionId} already has a turn in flight`, out);
      return;
    }
    // Cancel-then-reuse race: a stray cancel, or a prompt inside the settle window, is answered
    // "cancelled" at once without running a script (spike S5).
    if (session.poisoned) {
      session.poisoned = false;
      this.reply(id, { stopReason: "cancelled" }, out);
      return;
    }
    if (session.metadataPending || this.now < session.settleUntil) {
      this.reply(id, { stopReason: "cancelled" }, out);
      return;
    }
    const steps = this.pickSteps(text);
    const turn: Turn = {
      sessionId,
      reqId: id,
      steps,
      startedAt: this.now,
      idx: 0,
      wakeAt: undefined,
      gate: undefined,
      permissionId: undefined,
    };
    this.turns.set(sessionId, turn);
    this.run(turn, out);
  }

  private onCancel(params: Obj): void {
    const sessionId = params["sessionId"];
    if (typeof sessionId !== "string") return;
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    const turn = this.turns.get(sessionId);
    this.cancels.push({ sessionId, inFlight: turn !== undefined });
    if (turn === undefined) {
      session.poisoned = true;
      return;
    }
    const settleMs = this.script.settleMs ?? DEFAULT_SETTLE_MS;
    session.settleUntil = this.now + settleMs;
    session.metadataPending = this.script.metadataAfterCancel === true;
    session.cancelledTurnMs = this.now - turn.startedAt;
    this.pendingOut.push(...this.finish(turn, "cancelled"));
  }

  /** Lines produced by onCancel, flushed by the caller via fireDue. */
  private readonly pendingOut: string[] = [];

  private onClientResponse(id: RpcId, msg: Obj, out: string[]): void {
    let optionId: string | null = null;
    const result = msg["result"];
    if (isObj(result) && isObj(result["outcome"]) && typeof result["outcome"]["optionId"] === "string") {
      optionId = result["outcome"]["optionId"];
    }
    this.permissionAnswers.push({ id, optionId });
    for (const turn of [...this.turns.values()]) {
      if (turn.permissionId !== undefined && turn.permissionId === id) {
        turn.permissionId = undefined;
        this.run(turn, out);
      }
    }
  }

  // ---- turns --------------------------------------------------------------------------------

  private pickSteps(text: string): readonly Step[] {
    const { turns } = this.script;
    for (let i = 0; i < turns.length; i += 1) {
      const t = turns[i];
      if (t?.match !== undefined && !this.usedTurnScripts.has(i) && new RegExp(t.match).test(text)) {
        this.usedTurnScripts.add(i);
        return t.steps;
      }
    }
    for (let i = 0; i < turns.length; i += 1) {
      const t = turns[i];
      if (t !== undefined && t.match === undefined && !this.usedTurnScripts.has(i)) {
        this.usedTurnScripts.add(i);
        return t.steps;
      }
    }
    return [{ chunk: "ok" }];
  }

  /** Runs steps until the turn blocks (delay, gate, permission), finishes or crashes. */
  private run(turn: Turn, out: string[]): void {
    for (;;) {
      if (this.exitCode !== undefined) return;
      const step = turn.steps[turn.idx];
      if (step === undefined) {
        out.push(...this.finish(turn, "end_turn"));
        return;
      }
      turn.idx += 1;
      if ("chunk" in step) {
        out.push(this.update(turn.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: step.chunk } }));
      } else if ("thought" in step) {
        out.push(this.update(turn.sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: step.thought } }));
      } else if ("toolCall" in step) {
        this.permissionCounter += 1;
        out.push(this.update(turn.sessionId, { sessionUpdate: "tool_call", ...this.toolCallBody(step.toolCall, this.permissionCounter) }));
      } else if ("permission" in step) {
        this.permissionCounter += 1;
        const n = this.permissionCounter;
        const id: RpcId = step.permission.ids === "number" ? n : `fake-perm-${n}`;
        turn.permissionId = id;
        const legacy = this.script.permissionShape === "legacy";
        if (!legacy) {
          out.push(this.update(turn.sessionId, { sessionUpdate: "tool_call", ...this.kiroToolCallBody(step.permission.toolCall, n) }));
        }
        out.push(JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "session/request_permission",
          params: {
            sessionId: turn.sessionId,
            toolCall: legacy ? this.toolCallBody(step.permission.toolCall, n) : this.kiroPermissionBody(step.permission.toolCall, n),
            options: [
              { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
              { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
              { optionId: "reject_once", name: "Reject", kind: "reject_once" },
            ],
          },
        }));
        return;
      } else if ("metadata" in step) {
        out.push(this.metadata(turn.sessionId, step.metadata.turnDurationMs ?? this.now - turn.startedAt, step.metadata.credits));
      } else if ("delay" in step) {
        if (step.delay > 0) {
          turn.wakeAt = this.now + step.delay;
          return;
        }
      } else if ("gate" in step) {
        if (!this.released.has(step.gate)) {
          turn.gate = step.gate;
          return;
        }
      } else if ("crash" in step) {
        this.exitCode = step.crash;
        return;
      } else if ("probe" in step) {
        const cwd = this.sessions.get(turn.sessionId)?.cwd ?? "/";
        const spec = step.probe.replace(/^write:@cwd\//, `write:${cwd}/`);
        const result = this.probe === undefined ? "probe unavailable" : this.probe(spec);
        out.push(this.update(turn.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `probe ${step.probe} => ${result}\n` } }));
      } else {
        out.push(...this.finish(turn, step.stop));
        return;
      }
    }
  }

  private finish(turn: Turn, stopReason: string): string[] {
    this.turns.delete(turn.sessionId);
    return [JSON.stringify({ jsonrpc: "2.0", id: turn.reqId, result: { stopReason } })];
  }

  private toolCallBody(spec: ToolCallSpec, n: number): Record<string, unknown> {
    const rawInput: Record<string, string> = {};
    if (spec.path !== undefined) rawInput["path"] = spec.path;
    if (spec.command !== undefined) rawInput["command"] = spec.command;
    return { toolCallId: `fake-tool-${n}`, title: spec.title, kind: spec.kind, status: "pending", rawInput };
  }

  /** What kiro puts in `rawInput`: the edit tool's verb and path, the shell command, or a read verb and path. */
  private kiroRawInput(spec: ToolCallSpec): Record<string, string> {
    const rawInput: Record<string, string> = {};
    if (spec.kind === "execute") {
      if (spec.command !== undefined) rawInput["command"] = spec.command;
      return rawInput;
    }
    if (spec.kind === "edit") rawInput["command"] = "create";
    else if (spec.kind === "read") rawInput["command"] = "read";
    else if (spec.command !== undefined) rawInput["command"] = spec.command;
    if (spec.path !== undefined) rawInput["path"] = spec.path;
    return rawInput;
  }

  /** Kiro's `tool_call` update: carries the kind and the locations. */
  private kiroToolCallBody(spec: ToolCallSpec, n: number): Record<string, unknown> {
    const body: Record<string, unknown> = {
      toolCallId: `fake-tool-${n}`,
      title: spec.title,
      kind: spec.kind,
      rawInput: this.kiroRawInput(spec),
    };
    if (spec.path !== undefined) body["locations"] = [{ path: spec.path, line: 1 }];
    return body;
  }

  /** Kiro's `session/request_permission` toolCall: no `kind`, no `locations`. */
  private kiroPermissionBody(spec: ToolCallSpec, n: number): Record<string, unknown> {
    return { toolCallId: `fake-tool-${n}`, title: spec.title, rawInput: this.kiroRawInput(spec) };
  }

  // ---- virtual time -------------------------------------------------------------------------

  private nextEventTime(): number | undefined {
    let next: number | undefined;
    const consider = (t: number): void => {
      if (next === undefined || t < next) next = t;
    };
    for (const turn of this.turns.values()) if (turn.wakeAt !== undefined) consider(turn.wakeAt);
    for (const s of this.sessions.values()) if (s.metadataPending) consider(s.settleUntil);
    return next;
  }

  private fireDue(out: string[]): void {
    out.push(...this.pendingOut.splice(0));
    for (const s of this.sessions.values()) {
      if (s.metadataPending && s.settleUntil <= this.now) {
        s.metadataPending = false;
        out.push(this.metadata(s.id, s.cancelledTurnMs, undefined));
      }
    }
    for (const turn of [...this.turns.values()]) {
      if (turn.wakeAt !== undefined && turn.wakeAt <= this.now) {
        turn.wakeAt = undefined;
        this.run(turn, out);
      }
    }
  }

  // ---- wire helpers -------------------------------------------------------------------------

  private update(sessionId: string, update: Record<string, unknown>): string {
    return JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
  }

  private metadata(sessionId: string, turnDurationMs: number, credits: readonly CreditSpec[] | undefined): string {
    const params: Record<string, unknown> = { sessionId, turnDurationMs };
    if (credits !== undefined) params["meteringUsage"] = credits;
    return JSON.stringify({ jsonrpc: "2.0", method: "_kiro.dev/metadata", params });
  }

  private reply(id: RpcId | undefined, result: unknown, out: string[]): void {
    if (id !== undefined) out.push(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  private replyError(id: RpcId | undefined, code: number, message: string, out: string[]): void {
    if (id !== undefined) out.push(this.error(id, code, message));
  }

  private error(id: RpcId | null, code: number, message: string): string {
    return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  }
}

// ---- stdio wrapper ----------------------------------------------------------------------------

/** Real effects of a `probe` step (agent-sandbox task 8.3); one line of text, never throws. */
const runProbe = (spec: string): string => {
  const short = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "";
  try {
    if (spec === "status") {
      const status = readFileSync("/proc/self/status", "utf8");
      const pick = (k: string): string => /^(\S+):\s*(.*)$/m.exec(status.split("\n").find((l) => l.startsWith(`${k}:`)) ?? "")?.[2]?.trim() ?? "?";
      return `CapEff=${pick("CapEff")} NoNewPrivs=${pick("NoNewPrivs")} Uid=${pick("Uid").split(/\s+/)[0] ?? "?"}`;
    }
    if (spec === "git") {
      const r = spawnSync("git", ["rev-parse", "--git-dir"], { encoding: "utf8" });
      return r.status === 0 ? `ok ${r.stdout.trim()}` : `failed ${String(r.status)}`;
    }
    if (spec.startsWith("env:")) {
      return spec
        .slice(4)
        .split(",")
        .map((n) => `${n}=${process.env[n] === undefined ? "<unset>" : "<set>"}`)
        .join(" ");
    }
    if (spec.startsWith("write:")) {
      writeFileSync(spec.slice(6), "probe\n");
      return "written";
    }
    if (spec.startsWith("connect:")) {
      const [host, port] = [spec.slice(8, spec.lastIndexOf(":")), spec.slice(spec.lastIndexOf(":") + 1)];
      const r = spawnSync("nc", ["-z", "-w", "2", host, port], { encoding: "utf8" });
      return r.status === 0 ? "connected" : "unreachable";
    }
    return "unknown probe";
  } catch (e) {
    return `error ${short(e)}`;
  }
};

const runStdio = (): void => {
  const agentName = process.env["FAKE_AGENT_NAME"] ?? "fake";
  let script: FakeScript;
  try {
    script = loadScript(process.env["FAKE_AGENT_SCRIPT"]);
  } catch (e) {
    process.stderr.write(`fake-agent: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }
  const core = new FakeAgentCore({ agentName, script, probe: runProbe });
  const dumpEnv = process.env["FAKE_AGENT_DUMP_FILE"];
  const dumpFile = dumpEnv === undefined || dumpEnv === "" ? undefined : dumpEnv;
  const emit = (lines: readonly string[]): void => {
    const data = lines.map((l) => `${l}\n`).join("");
    if (core.exitCode !== undefined) {
      const code = core.exitCode;
      process.stdout.write(data, () => process.exit(code));
      return;
    }
    if (data !== "") process.stdout.write(data);
  };
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const out = core.handleLine(line);
    // Optional recording for black-box tests: the latest dump is rewritten after every line.
    if (dumpFile !== undefined) writeFileSync(dumpFile, JSON.stringify(core.dump()));
    // fake/advance is handled inside handleLine; nothing else needs the wrapper.
    emit(out);
  });
  rl.on("close", () => process.exit(0));
};

const isMain = (): boolean => {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMain()) runStdio();
