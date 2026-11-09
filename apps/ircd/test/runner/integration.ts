import { cp, mkdtemp, realpath, rm } from "node:fs/promises";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRunner, loadRunnerConfig } from "@seance/runner";
import type { Clock, Runner, RunnerLogger } from "@seance/runner";
import { loadConfig } from "../../src/config.js";
import { createIrcHost } from "../../src/runner-wiring.js";
import { createServer } from "../../src/server.js";
import type { IrcServer } from "../../src/server.js";
// The runner's own fixtures are shared by relative path; this is test-only and
// keeps `apps/runner` free of any dependency on `@seance/ircd` (no package cycle).
import { ManualClock } from "../../../runner/test/fixtures/manual-clock.js";
import { createTempRepo } from "../../../runner/test/fixtures/temp-repo.js";
import type { TempRepo } from "../../../runner/test/fixtures/temp-repo.js";

export { ManualClock };

const HERE = fileURLToPath(new URL(".", import.meta.url));
/** Repository root (apps/ircd/test/runner -> four levels up). */
export const REPO_ROOT = resolve(HERE, "../../../..");
/** The Fake_Agent launcher; `SEANCE_KIRO_BIN` points here. */
export const FAKE_KIRO_BIN = join(REPO_ROOT, "apps/runner/test/fixtures/fake-kiro");

const DEFAULT_WAIT_MS = 5_000;

/** A Fake_Agent script: inline object (JSON-encoded) or a raw JSON string. */
export type FakeAgentScript = Readonly<Record<string, unknown>> | string;

export interface IntegrationOptions {
  /** Value for `FAKE_AGENT_SCRIPT`; unset leaves the Fake_Agent's default script. */
  readonly script?: FakeAgentScript;
  /** Defaults to a fresh `ManualClock`. Pass `realClock` when using `vi.useFakeTimers()`. */
  readonly clock?: Clock;
  /** Extra `SEANCE_*` variables (e.g. `SEANCE_INVITERS`, `SEANCE_CHANNEL_CREDIT_CAP`). */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Files to delete from the copied agents dir (relative to it), e.g.
   * `.kiro/agents/coder.json`, to exercise `AgentFileMissingError`.
   */
  readonly removeAgentFiles?: readonly string[];
  /** `IRCD_SERVER_NAME` (agents' virtual host); default `seance.local`. */
  readonly serverName?: string;
  /** `IRCD_FLOOD_BURST`: lines a connection may send at once (default: the ircd default). */
  readonly floodBurst?: number;
  /** Skip `runner.start()` (startup-failure tests call it themselves). */
  readonly autoStart?: boolean;
  /** Extra `IRCD_*` variables for the ircd (e.g. `IRCD_ACCOUNTS_FILE`, public-hardening). */
  readonly ircdEnv?: Readonly<Record<string, string>>;
}

/** One log record captured from the runner. */
export interface LogRecord {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly msg: string;
  readonly fields: Readonly<Record<string, unknown>> | undefined;
}

/** A TCP IRC test client. */
export interface IrcTestClient {
  readonly nick: string;
  /** Every line received so far, without CRLF. */
  readonly lines: readonly string[];
  /** Sends one line (CRLF appended). Rejects CR/LF/NUL inside `line`. */
  send(line: string): void;
  /** NICK + USER, then waits for `001`. */
  register(): Promise<void>;
  /** JOIN and waits for the end of the NAMES list (366). */
  join(channel: string): Promise<void>;
  /**
   * Resolves with the first not-yet-consumed line matching `match`, and
   * consumes everything up to and including it. Rejects after `timeoutMs`
   * with the last lines received.
   */
  waitFor(match: RegExp | ((line: string) => boolean), timeoutMs?: number): Promise<string>;
  /** Resolves true when no unconsumed line matches within `quietMs`. */
  expectNone(match: RegExp | ((line: string) => boolean), quietMs?: number): Promise<boolean>;
  close(): Promise<void>;
}

export interface IntegrationFixture {
  readonly server: IrcServer;
  readonly runner: Runner;
  readonly clock: Clock;
  readonly ports: { readonly tcpPort: number; readonly wsPort: number };
  readonly repo: TempRepo;
  readonly workspaces: string;
  readonly agentsDir: string;
  readonly logs: readonly LogRecord[];
  /**
   * Registered client with `+o` on whatever channel it creates first. `pass` is sent as `PASS`
   * first (a guest password or `<nick>:<secret>`, public-hardening).
   */
  connectClient(nick: string, pass?: string): Promise<IrcTestClient>;
  /** Idempotent; closes clients, runner, server, env and temp directories. */
  close(): Promise<void>;
}

const matcher = (match: RegExp | ((line: string) => boolean)): ((line: string) => boolean) =>
  typeof match === "function" ? match : (line) => match.test(line);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class TcpClient implements IrcTestClient {
  readonly #socket: Socket;
  readonly #received: string[] = [];
  #cursor = 0;
  #partial = "";
  #closed = false;
  readonly #listeners = new Set<() => void>();

  constructor(
    readonly nick: string,
    socket: Socket,
  ) {
    this.#socket = socket;
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.#partial += chunk;
      const parts = this.#partial.split("\n");
      this.#partial = parts.pop() ?? "";
      for (const part of parts) this.#received.push(part.endsWith("\r") ? part.slice(0, -1) : part);
      for (const l of [...this.#listeners]) l();
    });
    // Errors surface as failed waits (timeout shows the lines); never an unhandled event.
    socket.on("error", () => {
      for (const l of [...this.#listeners]) l();
    });
  }

  get lines(): readonly string[] {
    return this.#received;
  }

  send(line: string): void {
    if (/[\r\n\0]/.test(line)) throw new Error(`test client ${this.nick}: line contains CR, LF or NUL`);
    if (this.#closed) throw new Error(`test client ${this.nick}: socket is closed, cannot send ${JSON.stringify(line)}`);
    this.#socket.write(`${line}\r\n`);
  }

  async register(): Promise<void> {
    this.send(`NICK ${this.nick}`);
    this.send(`USER ${this.nick} 0 * :${this.nick}`);
    await this.waitFor(/^:\S+ 001 /);
  }

  async join(channel: string): Promise<void> {
    this.send(`JOIN ${channel}`);
    await this.waitFor(new RegExp(`^:\\S+ 366 \\S+ ${escapeRegExp(channel)} `, "i"));
  }

  #find(test: (line: string) => boolean): number {
    for (let i = this.#cursor; i < this.#received.length; i++) {
      const line = this.#received[i];
      if (line !== undefined && test(line)) return i;
    }
    return -1;
  }

  waitFor(match: RegExp | ((line: string) => boolean), timeoutMs = DEFAULT_WAIT_MS): Promise<string> {
    const test = matcher(match);
    return new Promise<string>((res, rej) => {
      const attempt = (): boolean => {
        const at = this.#find(test);
        if (at < 0) return false;
        this.#cursor = at + 1;
        cleanup();
        res(this.#received[at] ?? "");
        return true;
      };
      const timer = setTimeout(() => {
        cleanup();
        const tail = this.#received.slice(-10).join("\n  ");
        rej(new Error(`test client ${this.nick}: no matching line within ${timeoutMs}ms; last lines:\n  ${tail}`));
      }, timeoutMs);
      const listener = (): void => {
        attempt();
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        this.#listeners.delete(listener);
      };
      this.#listeners.add(listener);
      attempt();
    });
  }

  async expectNone(match: RegExp | ((line: string) => boolean), quietMs = 300): Promise<boolean> {
    await sleep(quietMs);
    return this.#find(matcher(match)) < 0;
  }

  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closed = true;
    return new Promise((res) => {
      this.#socket.once("close", () => res());
      this.#socket.destroy();
    });
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const live = new Set<IntegrationFixture>();

/** Closes every fixture still open; call from `afterEach`. */
export async function closeAllFixtures(): Promise<void> {
  const errors: unknown[] = [];
  for (const fixture of [...live]) {
    try {
      await fixture.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `${errors.length} integration fixture(s) failed to close`);
  }
}

const ENV_KEYS = ["FAKE_AGENT_SCRIPT"] as const;

/**
 * Starts an in-process ircd (TCP and WebSocket on port 0, loopback only) with
 * a real `Runner` over `createIrcHost`, the Fake_Agent as `kiro-cli`, a
 * temporary target repository, workspaces root and agents directory.
 * Everything is released by `fixture.close()` even when setup fails halfway.
 */
export async function startIntegration(options: IntegrationOptions = {}): Promise<IntegrationFixture> {
  const cleanups: Array<() => Promise<void>> = [];
  const clients = new Set<IrcTestClient>();
  const logs: LogRecord[] = [];
  let closed: Promise<void> | undefined;

  const closeFixture = (): Promise<void> => {
    closed ??= (async () => {
      live.delete(fixture);
      const errors: unknown[] = [];
      for (const client of clients) await client.close().catch((e: unknown) => errors.push(e));
      for (const fn of cleanups.reverse()) await fn().catch((e: unknown) => errors.push(e));
      if (errors.length > 0) throw new AggregateError(errors, "integration fixture teardown failed");
    })();
    return closed;
  };

  // `fixture` is defined below; closeFixture is only called afterwards or from the catch.
  let fixture!: IntegrationFixture;
  try {
    const savedEnv = new Map<string, string | undefined>(ENV_KEYS.map((k) => [k, process.env[k]]));
    cleanups.push(async () => {
      for (const [key, value] of savedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    if (options.script !== undefined) {
      process.env["FAKE_AGENT_SCRIPT"] =
        typeof options.script === "string" ? options.script : JSON.stringify(options.script);
    } else {
      delete process.env["FAKE_AGENT_SCRIPT"];
    }

    const repo = await createTempRepo();
    cleanups.push(() => repo.dispose());
    const scratch = await realpath(await mkdtemp(join(tmpdir(), "seance-integration-")));
    cleanups.push(() => rm(scratch, { recursive: true, force: true }));
    const workspaces = join(scratch, "workspaces");
    const agentsDir = join(scratch, "agents");
    await cp(join(REPO_ROOT, "agents"), agentsDir, { recursive: true });
    for (const rel of options.removeAgentFiles ?? []) {
      await rm(join(agentsDir, rel), { force: true });
    }

    const clock = options.clock ?? new ManualClock();
    const logger: RunnerLogger = {
      debug: (msg, fields) => void logs.push({ level: "debug", msg, fields }),
      info: (msg, fields) => void logs.push({ level: "info", msg, fields }),
      warn: (msg, fields) => void logs.push({ level: "warn", msg, fields }),
      error: (msg, fields) => void logs.push({ level: "error", msg, fields }),
    };

    const config = loadRunnerConfig(
      {
        SEANCE_KIRO_BIN: FAKE_KIRO_BIN,
        SEANCE_TARGET_REPO: repo.path,
        SEANCE_WORKSPACES: workspaces,
        SEANCE_AGENTS_DIR: agentsDir,
        ...options.env,
      },
      REPO_ROOT,
    );

    // Lazy resolver, exactly as in apps/ircd/src/index.ts.
    let runner: Runner | undefined;
    const server = createServer(
      loadConfig({
        IRCD_TCP_PORT: "0",
        IRCD_WS_PORT: "0",
        IRCD_HOST: "127.0.0.1",
        ...(options.floodBurst !== undefined ? { IRCD_FLOOD_BURST: String(options.floodBurst) } : {}),
        ...(options.serverName !== undefined ? { IRCD_SERVER_NAME: options.serverName } : {}),
        ...options.ircdEnv,
      }),
      { error: () => undefined, debug: () => undefined },
      {
        inviteResolver: (t, c, i) => runner?.inviteResolver(t, c, i) ?? false,
        reservedNicks: () => runner?.agentNicks() ?? [],
      },
    );
    const created = createRunner({
      host: createIrcHost(server),
      config,
      logger,
      clock,
      bindHost: "127.0.0.1",
      // Agent processes only inherit an allow-list; the Fake_Agent's own variables are passed on.
      childEnv: () =>
        Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("FAKE_AGENT_"))),
    });
    runner = created;
    // Cleanups run in reverse: runner shutdown first, then the server stops (as in index.ts).
    cleanups.push(async () => {
      // server.stop() is safe even if start() never ran or failed.
      await server.stop();
    });
    cleanups.push(async () => {
      await created.shutdown();
    });
    if (options.autoStart !== false) await created.start();
    const ports = await server.start();

    fixture = {
      server,
      runner: created,
      clock,
      ports,
      repo,
      workspaces,
      agentsDir,
      logs,
      async connectClient(nick, pass) {
        const socket = await new Promise<Socket>((res, rej) => {
          const s = connect(ports.tcpPort, "127.0.0.1");
          s.once("connect", () => res(s));
          s.once("error", (e) => rej(new Error(`test client ${nick} could not connect to port ${ports.tcpPort}: ${e.message}`)));
        });
        const client = new TcpClient(nick, socket);
        clients.add(client);
        if (pass !== undefined) client.send(`PASS ${pass}`);
        await client.register();
        return client;
      },
      close: closeFixture,
    };
    live.add(fixture);
    return fixture;
  } catch (error) {
    await closeFixture().catch(() => undefined);
    throw error;
  }
}
