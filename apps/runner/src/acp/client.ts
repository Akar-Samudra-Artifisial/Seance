/**
 * AcpClient: newline-delimited JSON-RPC 2.0 client for `kiro-cli acp`, promoted from the spike.
 * One instance owns at most one live agent process; the next request after an exit spawns a new one
 * (Req 2.13). Every inbound line goes through `parseFrame` (Req 2.11, 2.12) and every logged frame,
 * command line and error goes through redaction (Req 2.10).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Clock, TimerHandle } from "../clock.js";
import type { RunnerLogger } from "../log.js";
import {
  encodeErrorResponse,
  encodeNotification,
  encodeRequest,
  encodeResponse,
  parseFrame,
  type FrameId,
  type Json,
  type JsonObject,
} from "./frames.js";
import { redact, redactValues } from "./redact.js";

export type { FrameId, Json, JsonObject } from "./frames.js";

export interface IncomingRequest {
  readonly id: FrameId;
  readonly method: string;
  readonly params: JsonObject;
}

export type RequestHandler = (req: IncomingRequest) => Promise<JsonObject>;
export type NotificationListener = (method: string, params: JsonObject) => void;
export type ActivityListener = () => void;
export type ExitInfo = { readonly code: number | null; readonly signal: NodeJS.Signals | null };

export interface AcpClientOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly logger: RunnerLogger;
  readonly clock: Clock;
}

/** Grace period between SIGTERM and SIGKILL in `close()` (Req 11.5). */
export const KILL_GRACE_MS = 5000;

const PERMISSION_METHOD = "session/request_permission";
const CANCELLED_OUTCOME: JsonObject = { outcome: { outcome: "cancelled" } };

export class RpcError extends Error {
  readonly code: number;
  readonly data: Json | undefined;
  constructor(method: string, code: number, message: string, data: Json | undefined) {
    super(`${method} failed: [${code}] ${message}`);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

interface Pending {
  readonly method: string;
  readonly resolve: (v: JsonObject) => void;
  readonly reject: (e: Error) => void;
}

/** State of one spawned process; late events from an old process never touch a newer one. */
interface Proc {
  readonly child: ChildProcess;
  readonly pending: Map<string, Pending>;
  readonly exited: Promise<ExitInfo>;
  readonly settle: (info: ExitInfo) => void;
  lastStderr: string;
  initialized: boolean;
  done: boolean;
}

const describeExit = (info: ExitInfo): string =>
  info.signal !== null ? `signal ${info.signal}` : `exit code ${String(info.code)}`;

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class AcpClient {
  readonly notificationCounts = new Map<string, number>();
  readonly requestCounts = new Map<string, number>();
  private readonly opts: AcpClientOptions;
  private readonly listeners = new Set<NotificationListener>();
  private readonly activity = new Set<ActivityListener>();
  private readonly handlers = new Map<string, RequestHandler>();
  private proc: Proc | undefined;
  private lastExit: ExitInfo = { code: null, signal: null };
  private nextId = 1;
  private closing: Promise<void> | undefined;

  constructor(opts: AcpClientOptions) {
    this.opts = opts;
  }

  /** Pid of the live process, if any. */
  get pid(): number | undefined {
    return this.proc?.child.pid;
  }

  /** True while a spawned process has not exited. */
  get running(): boolean {
    return this.proc !== undefined && !this.proc.done;
  }

  /** The last stderr line of the current (or most recent) process. */
  get lastStderrLine(): string {
    return this.proc?.lastStderr ?? "";
  }

  /** Resolves when the current process exits; already resolved when none is running. */
  get exited(): Promise<ExitInfo> {
    return this.proc?.exited ?? Promise.resolve(this.lastExit);
  }

  onNotification(listener: NotificationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Fires on every frame from the agent, valid or invalid (used by the hung-agent watchdog). */
  onActivity(listener: ActivityListener): () => void {
    this.activity.add(listener);
    return () => this.activity.delete(listener);
  }

  handle(method: string, handler: RequestHandler): void {
    this.handlers.set(method, handler);
  }

  /** Sends a request, spawning the process first if none is live. */
  request(method: string, params: JsonObject): Promise<JsonObject> {
    if (this.closing !== undefined) return Promise.reject(new Error(`${method} not sent: client is closed`));
    const proc = this.ensureProc();
    const id = this.nextId++;
    return new Promise<JsonObject>((resolve, reject) => {
      if (proc.done) {
        reject(this.failure(proc, method));
        return;
      }
      proc.pending.set(String(id), { method, resolve, reject });
      this.send(proc, encodeRequest(id, method, params), "request");
    });
  }

  /** Sends a notification to the live process. Returns false (and sends nothing) when none is live. */
  notify(method: string, params: JsonObject): boolean {
    const proc = this.proc;
    if (proc === undefined || proc.done) {
      this.opts.logger.debug("acp notification dropped: no live agent process", { method });
      return false;
    }
    this.send(proc, encodeNotification(method, params), "notification");
    return true;
  }

  /** Signals the current process; resolves with its exit once it is gone. */
  kill(signal: NodeJS.Signals = "SIGTERM"): Promise<ExitInfo> {
    const proc = this.proc;
    if (proc === undefined || proc.done) return Promise.resolve(this.lastExit);
    this.signal(proc, signal);
    return proc.exited;
  }

  /**
   * Signals the whole process group (the agent is spawned detached, so it leads its own group and
   * its tool subprocesses die with it). Falls back to the child alone if the group is unreachable.
   */
  private signal(proc: Proc, signal: NodeJS.Signals): void {
    const pid = proc.child.pid;
    if (pid !== undefined && process.platform !== "win32") {
      try {
        process.kill(-pid, signal);
        return;
      } catch (err) {
        this.opts.logger.debug("acp process group signal failed, signalling child only", {
          signal,
          error: errMessage(err),
        });
      }
    }
    proc.child.kill(signal);
  }

  /** Ends stdin, SIGTERM, SIGKILL after 5 s; idempotent. The client cannot be reused afterwards. */
  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    const proc = this.proc;
    if (proc === undefined || proc.done) return;
    proc.child.stdin?.end();
    this.signal(proc, "SIGTERM");
    const timer: TimerHandle = this.opts.clock.setTimeout(() => {
      this.opts.logger.warn("acp process ignored SIGTERM, sending SIGKILL", { command: this.opts.command });
      this.signal(proc, "SIGKILL");
    }, KILL_GRACE_MS);
    try {
      await proc.exited;
    } finally {
      this.opts.clock.clearTimeout(timer);
    }
  }

  private secrets(): readonly (string | undefined)[] {
    return [this.opts.env["KIRO_API_KEY"]];
  }

  private safe(text: string): string {
    return redact(redactValues(text, this.secrets()));
  }

  private ensureProc(): Proc {
    if (this.proc !== undefined && !this.proc.done) return this.proc;
    const { command, args, cwd, env, logger } = this.opts;
    logger.debug("acp spawn", { command: this.safe(command), args: args.map((a) => this.safe(a)), cwd });

    let settle: (info: ExitInfo) => void = () => undefined;
    const exited = new Promise<ExitInfo>((resolve) => {
      settle = resolve;
    });
    const child = spawn(command, [...args], { cwd, env: { ...env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    const proc: Proc = { child, pending: new Map(), exited, settle, lastStderr: "", initialized: false, done: false };
    this.proc = proc;

    child.once("error", (err) => {
      logger.error("acp spawn failed", { command, error: this.safe(err.message) });
      proc.lastStderr = proc.lastStderr === "" ? this.safe(err.message) : proc.lastStderr;
      this.finish(proc, { code: null, signal: null });
    });
    // 'close' fires after stdio ends, so the last stderr line is captured before pending requests reject.
    child.once("close", (code, signal) => this.finish(proc, { code, signal }));
    child.stdin.on("error", (err) => {
      logger.warn("acp stdin error", { error: this.safe(err.message) });
    });
    createInterface({ input: child.stdout }).on("line", (line) => this.onLine(proc, line));
    createInterface({ input: child.stderr }).on("line", (line) => {
      const safe = this.safe(line);
      if (safe.trim() !== "") proc.lastStderr = safe;
      logger.debug("acp stderr", { line: safe });
    });
    return proc;
  }

  private failure(proc: Proc, method: string): Error {
    const info = this.lastExit;
    const stderr = proc.lastStderr === "" ? "none" : proc.lastStderr;
    if (!proc.initialized) {
      const why = info.code === null && info.signal === null ? "spawn error" : describeExit(info);
      return new Error(`${this.safe(this.opts.command)} failed: ${why}, last stderr: ${stderr}`);
    }
    return new Error(`${method} aborted: agent process exited (${describeExit(info)}), last stderr: ${stderr}`);
  }

  private finish(proc: Proc, info: ExitInfo): void {
    if (proc.done) return;
    proc.done = true;
    this.lastExit = info;
    this.opts.logger.debug("acp exit", { code: info.code, signal: info.signal });
    const pending = [...proc.pending.values()];
    proc.pending.clear();
    for (const p of pending) p.reject(this.failure(proc, p.method));
    proc.settle(info);
  }

  private send(proc: Proc, line: string, what: string): void {
    this.opts.logger.debug(`acp >> ${what}`, { frame: this.safe(line.trimEnd()) });
    proc.child.stdin?.write(line);
  }

  private onLine(proc: Proc, line: string): void {
    if (line.trim() === "") return;
    this.opts.logger.debug("acp <<", { frame: this.safe(line) });
    for (const l of [...this.activity]) l();
    const frame = parseFrame(line);
    switch (frame.kind) {
      case "invalid":
        this.opts.logger.error("acp frame discarded", { reason: frame.reason, frame: this.safe(line) });
        return;
      case "request":
        void this.onRequest(proc, { id: frame.id, method: frame.method, params: frame.params });
        return;
      case "notification":
        this.notificationCounts.set(frame.method, (this.notificationCounts.get(frame.method) ?? 0) + 1);
        for (const l of [...this.listeners]) l(frame.method, frame.params);
        return;
      case "response":
        this.settleResponse(proc, frame.id, { ok: frame.result });
        return;
      case "error-response":
        this.settleResponse(proc, frame.id, { code: frame.code, message: frame.message, data: frame.data });
        return;
    }
  }

  private settleResponse(
    proc: Proc,
    id: FrameId,
    outcome: { readonly ok: JsonObject } | { readonly code: number; readonly message: string; readonly data: Json | undefined },
  ): void {
    const key = String(id);
    const p = proc.pending.get(key);
    if (p === undefined) {
      this.opts.logger.warn("acp response for unknown id", { id: key });
      return;
    }
    proc.pending.delete(key);
    if ("ok" in outcome) {
      if (p.method === "initialize") proc.initialized = true;
      p.resolve(outcome.ok);
    } else {
      if (p.method === "initialize") proc.initialized = true;
      p.reject(new RpcError(p.method, outcome.code, this.safe(outcome.message), outcome.data));
    }
  }

  private async onRequest(proc: Proc, req: IncomingRequest): Promise<void> {
    this.requestCounts.set(req.method, (this.requestCounts.get(req.method) ?? 0) + 1);
    const handler = this.handlers.get(req.method);
    if (handler === undefined) {
      this.reply(proc, encodeErrorResponse(req.id, -32601, `Method not found: ${req.method}`));
      return;
    }
    try {
      this.reply(proc, encodeResponse(req.id, await handler(req)));
    } catch (err) {
      this.opts.logger.error("acp request handler failed", { method: req.method, error: this.safe(errMessage(err)) });
      // A permission request is never left unanswered: a failed handler means cancelled (Req 8.9).
      this.reply(
        proc,
        req.method === PERMISSION_METHOD
          ? encodeResponse(req.id, CANCELLED_OUTCOME)
          : encodeErrorResponse(req.id, -32000, "request handler failed"),
      );
    }
  }

  private reply(proc: Proc, line: string): void {
    if (proc.done) {
      this.opts.logger.debug("acp reply dropped: agent process already exited");
      return;
    }
    this.send(proc, line, "response");
  }
}
