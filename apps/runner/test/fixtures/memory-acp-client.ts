// In-memory stand-in for one `podman run -i` agent process, for the lifecycle properties (P5, P6).
// It answers initialize, session/new and session/prompt without spawning anything.
import { AcpClient, type AcpClientOptions, type ExitInfo, type JsonObject } from "../../src/acp/client.js";

export type MemoryBehaviour =
  | { readonly kind: "ok" }
  /** `podman run` exits before `initialize` answers, like exit 125/126/127. */
  | { readonly kind: "start-exit"; readonly code: number }
  /** `initialize` never answers (slow start). */
  | { readonly kind: "silent" };

export class MemoryAcpClient extends AcpClient {
  readonly command: string;
  readonly containerName: string | undefined;
  readonly agent: string;
  readonly #behaviour: MemoryBehaviour;
  readonly #pending = new Set<(e: Error) => void>();
  #started = false;
  #done = false;
  #settle: (info: ExitInfo) => void = () => undefined;
  readonly #exited: Promise<ExitInfo>;
  #stderr = "";
  #sessions = 0;
  /** Calls that reached the agent (initialize answered), for P6. */
  initialized = false;

  constructor(opts: AcpClientOptions, behaviour: MemoryBehaviour) {
    super(opts);
    this.command = opts.command;
    this.containerName = opts.args.find((a) => a.startsWith("--name="))?.slice("--name=".length);
    this.agent = opts.args.at(-1) ?? "";
    this.#behaviour = behaviour;
    this.#exited = new Promise((resolve) => {
      this.#settle = resolve;
    });
  }

  override get running(): boolean {
    return this.#started && !this.#done;
  }

  override get exited(): Promise<ExitInfo> {
    return this.#exited;
  }

  override get lastStderrLine(): string {
    return this.#stderr;
  }

  override request(method: string, _params: JsonObject): Promise<JsonObject> {
    if (this.#done) return Promise.reject(new Error(`${method} aborted: agent process exited`));
    this.#started = true;
    if (method === "initialize") {
      if (this.#behaviour.kind === "start-exit") {
        this.#stderr = "Error: crun: open `/home/runner/x`: denied";
        const code = this.#behaviour.code;
        queueMicrotask(() => {
          this.#finish({ code, signal: null });
        });
        return Promise.reject(new Error(`podman failed: exit code ${code}, last stderr: ${this.#stderr}`));
      }
      if (this.#behaviour.kind === "silent") return this.#hold();
      this.initialized = true;
      return Promise.resolve({ protocolVersion: 1 });
    }
    if (method === "session/new") {
      this.#sessions += 1;
      return Promise.resolve({ sessionId: `${this.containerName ?? "s"}-${this.#sessions}`, modes: { currentModeId: this.agent } });
    }
    if (method === "session/prompt") return Promise.resolve({ stopReason: "end_turn" });
    return Promise.resolve({});
  }

  override notify(_method: string, _params: JsonObject): boolean {
    return !this.#done;
  }

  override kill(signal: NodeJS.Signals = "SIGTERM"): Promise<ExitInfo> {
    this.#finish({ code: null, signal });
    return this.#exited;
  }

  override close(): Promise<void> {
    this.#finish({ code: null, signal: "SIGTERM" });
    return this.#exited.then(() => undefined);
  }

  /** The agent process dies on its own (crash, `--timeout`). */
  crash(code = 1): void {
    this.#finish({ code, signal: null });
  }

  #hold(): Promise<JsonObject> {
    return new Promise((_resolve, reject) => {
      this.#pending.add(reject);
    });
  }

  #finish(info: ExitInfo): void {
    if (this.#done) return;
    this.#done = true;
    for (const reject of this.#pending) reject(new Error("agent process exited"));
    this.#pending.clear();
    this.#settle(info);
  }
}
