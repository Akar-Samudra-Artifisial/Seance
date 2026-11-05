// Minimal newline-delimited JSON-RPC 2.0 client for `kiro-cli acp` (spike quality).
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
import { createInterface } from "node:readline";

export type Json = null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json };
export type JsonObject = { readonly [k: string]: Json };

export interface IncomingRequest {
  readonly id: number | string;
  readonly method: string;
  readonly params: JsonObject;
}

export type RequestHandler = (req: IncomingRequest) => Promise<Json>;
export type NotificationListener = (method: string, params: JsonObject) => void;

interface Pending {
  readonly method: string;
  readonly resolve: (v: JsonObject) => void;
  readonly reject: (e: Error) => void;
}

export class RpcError extends Error {
  readonly code: number;
  readonly data: Json | undefined;
  constructor(method: string, code: number, message: string, data: Json | undefined) {
    super(`${method} failed: [${code}] ${message}`);
    this.code = code;
    this.data = data;
  }
}

const SECRET_KEY = /"([^"]*(?:token|secret|password|authorization|api[_-]?key|credential)[^"]*)"\s*:\s*"[^"]*"/gi;
export const redact = (line: string): string => line.replace(SECRET_KEY, '"$1":"[REDACTED]"');

export const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

export interface AcpClientOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly logPath: string;
}

export class AcpClient {
  readonly proc: ChildProcess;
  readonly startedAt: number;
  readonly notificationCounts = new Map<string, number>();
  readonly requestCounts = new Map<string, number>();
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private readonly log: WriteStream;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<NotificationListener>();
  private readonly handlers = new Map<string, RequestHandler>();
  private nextId = 1;
  private closed = false;
  private closing: Promise<void> | undefined;

  constructor(opts: AcpClientOptions) {
    this.startedAt = performance.now();
    this.log = createWriteStream(opts.logPath, { flags: "w" });
    this.proc = spawn(opts.command, [...opts.args], { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.exited = new Promise((resolve) => {
      this.proc.once("exit", (code, signal) => {
        this.closed = true;
        this.write("exit", JSON.stringify({ code, signal }));
        for (const p of this.pending.values()) p.reject(new Error(`${p.method} aborted: agent process exited (code=${code}, signal=${signal})`));
        this.pending.clear();
        resolve({ code, signal });
      });
    });
    this.proc.once("error", (err) => this.write("spawn-error", err.message));
    const stdout = this.proc.stdout;
    const stderr = this.proc.stderr;
    if (stdout === null || stderr === null) throw new Error("kiro-cli acp spawn failed: stdio pipes unavailable");
    createInterface({ input: stdout }).on("line", (line) => this.onLine(line));
    createInterface({ input: stderr }).on("line", (line) => this.write("stderr", line));
  }

  get pid(): number | undefined {
    return this.proc.pid;
  }

  onNotification(listener: NotificationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  handle(method: string, handler: RequestHandler): void {
    this.handlers.set(method, handler);
  }

  request(method: string, params: JsonObject): Promise<JsonObject> {
    if (this.closed) return Promise.reject(new Error(`${method} not sent: agent process already exited`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: JsonObject): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      if (!this.closed) {
        this.proc.stdin?.end();
        this.proc.kill("SIGTERM");
        await this.exited;
      }
      await new Promise<void>((r) => this.log.end(r));
    })();
    return this.closing;
  }

  private send(msg: JsonObject): void {
    const line = JSON.stringify(msg);
    this.write(">>", line);
    this.proc.stdin?.write(`${line}\n`);
  }

  private write(dir: string, line: string): void {
    const t = (performance.now() - this.startedAt).toFixed(0).padStart(7);
    this.log.write(`${t}ms ${dir} ${redact(line)}\n`);
  }

  private onLine(line: string): void {
    this.write("<<", line);
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      this.write("parse-error", `non-JSON line from agent: ${(err as Error).message}`);
      return;
    }
    if (!isObject(msg) || msg["jsonrpc"] !== "2.0") {
      this.write("protocol-error", "message is not a JSON-RPC 2.0 object");
      return;
    }
    const id = msg["id"];
    const method = msg["method"];
    const params = isObject(msg["params"]) ? msg["params"] : {};
    if (typeof method === "string" && (typeof id === "number" || typeof id === "string")) {
      void this.onRequest({ id, method, params });
    } else if (typeof method === "string") {
      this.notificationCounts.set(method, (this.notificationCounts.get(method) ?? 0) + 1);
      for (const l of this.listeners) l(method, params);
    } else if (typeof id === "number") {
      this.onResponse(id, msg);
    } else {
      this.write("protocol-error", "message has neither method nor numeric id");
    }
  }

  private onResponse(id: number, msg: JsonObject): void {
    const p = this.pending.get(id);
    if (p === undefined) {
      this.write("protocol-error", `response for unknown id ${id}`);
      return;
    }
    this.pending.delete(id);
    const err = msg["error"];
    if (isObject(err)) {
      const code = typeof err["code"] === "number" ? err["code"] : -1;
      const message = typeof err["message"] === "string" ? err["message"] : "unknown error";
      p.reject(new RpcError(p.method, code, message, err["data"]));
      return;
    }
    p.resolve(isObject(msg["result"]) ? msg["result"] : {});
  }

  private async onRequest(req: IncomingRequest): Promise<void> {
    this.requestCounts.set(req.method, (this.requestCounts.get(req.method) ?? 0) + 1);
    const handler = this.handlers.get(req.method);
    if (handler === undefined) {
      this.send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } });
      return;
    }
    try {
      const result = await handler(req);
      this.send({ jsonrpc: "2.0", id: req.id, result });
    } catch (err) {
      this.send({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: (err as Error).message } });
    }
  }
}
