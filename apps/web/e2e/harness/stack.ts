/**
 * Playwright globalSetup: starts the whole stack for the opt-in e2e run.
 *
 * - Ircd (in-process, TCP port 0, WebSocket on a free port, loopback only) with the web origin allow-listed
 * - Runner (in-process) with the Fake_Agent as `kiro-cli`, a temporary target repo, workspaces dir and agents copy
 * - `next build --webpack` and `next start` as child processes
 *
 * The Ircd and Runner sources are imported by relative path; Playwright's TypeScript loader resolves the
 * `.js` specifiers to `.ts` (proved by the task 16.1 spike).
 * The returned function is the teardown: it stops every process and socket and removes temp directories.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { cp, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../../ircd/src/config.js";
import { createIrcHost } from "../../../ircd/src/runner-wiring.js";
import { createServer } from "../../../ircd/src/server.js";
import { createRunner, loadRunnerConfig, realClock } from "../../../runner/src/index.js";
import type { Runner, RunnerLogger } from "../../../runner/src/index.js";
import { createTempRepo } from "../../../runner/test/fixtures/temp-repo.js";
import { E2E_WEB_PORT, E2E_WS_PORT } from "./env.js";
import { freePort } from "./free-port.js";

const WEB_DIR = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const REPO_ROOT = resolve(WEB_DIR, "../..");
const FAKE_KIRO_BIN = join(REPO_ROOT, "apps/runner/test/fixtures/fake-kiro");
const NEXT_BIN = join(WEB_DIR, "node_modules/next/dist/bin/next");

const BUILD_TIMEOUT_MS = 480_000;
const START_TIMEOUT_MS = 60_000;

/** A coloured sentence from `coder`: colour 12 (blue), text, reset. */
export const FAKE_REPLY = "\x0312The veil is thin tonight.\x0F";

/** Enough unmatched turns for every message a spec sends; each one replies with FAKE_REPLY. */
const FAKE_SCRIPT = JSON.stringify({
  settleMs: 0,
  turns: Array.from({ length: 8 }, () => ({ steps: [{ chunk: FAKE_REPLY }] })),
});

interface ManagedProcess {
  readonly name: string;
  readonly child: ChildProcess;
  readonly output: () => string;
  readonly exited: Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function launch(name: string, args: readonly string[], env: NodeJS.ProcessEnv): ManagedProcess {
  const chunks: string[] = [];
  // detached: own process group, so teardown can signal the whole group and leave no strays.
  const child = spawn(process.execPath, [NEXT_BIN, ...args], {
    cwd: WEB_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const keep = (data: Buffer): void => {
    chunks.push(data.toString("utf8"));
    if (chunks.length > 400) chunks.splice(0, chunks.length - 400);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  const exited = new Promise<void>((res) => {
    child.once("close", () => res());
    child.once("error", () => res());
  });
  return { name, child, output: () => chunks.join(""), exited };
}

function signalGroup(proc: ManagedProcess, signal: NodeJS.Signals): void {
  const pid = proc.child.pid;
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function stopProcess(proc: ManagedProcess): Promise<void> {
  if (proc.child.exitCode !== null || proc.child.signalCode !== null) {
    signalGroup(proc, "SIGKILL"); // reap any leftover group members
    return;
  }
  signalGroup(proc, "SIGTERM");
  const timedOut = await Promise.race([proc.exited.then(() => false), sleep(5_000).then(() => true)]);
  if (timedOut) {
    signalGroup(proc, "SIGKILL");
    await proc.exited;
  }
  signalGroup(proc, "SIGKILL");
}

async function runToCompletion(proc: ManagedProcess, timeoutMs: number): Promise<void> {
  const result = await Promise.race([
    proc.exited.then(() => "exited" as const),
    sleep(timeoutMs).then(() => "timeout" as const),
  ]);
  if (result === "timeout") {
    throw new Error(`${proc.name} did not finish within ${timeoutMs}ms; output:\n${proc.output()}`);
  }
  if (proc.child.exitCode !== 0) {
    throw new Error(`${proc.name} failed (exit ${String(proc.child.exitCode ?? proc.child.signalCode)}); output:\n${proc.output()}`);
  }
}

async function waitForHttp(url: string, proc: ManagedProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    if (proc.child.exitCode !== null || proc.child.signalCode !== null) {
      throw new Error(`${proc.name} exited before it became ready; output:\n${proc.output()}`);
    }
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status < 500) return;
      last = `HTTP ${res.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`${proc.name} was not ready at ${url} within ${timeoutMs}ms (${last}); output:\n${proc.output()}`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const cleanups: Array<() => Promise<void>> = [];
  const savedEnv = new Map<string, string | undefined>(
    [E2E_WEB_PORT, E2E_WS_PORT, "FAKE_AGENT_SCRIPT"].map((k) => [k, process.env[k]]),
  );
  cleanups.push(async () => {
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const teardown = async (): Promise<void> => {
    const errors: unknown[] = [];
    for (const fn of cleanups.splice(0).reverse()) await fn().catch((e: unknown) => errors.push(e));
    if (errors.length > 0) throw new AggregateError(errors, "e2e stack teardown failed");
  };

  try {
    const webPort = await freePort();
    let wsPort = await freePort();
    while (wsPort === webPort) wsPort = await freePort();
    process.env[E2E_WEB_PORT] = String(webPort);
    process.env[E2E_WS_PORT] = String(wsPort);
    process.env["FAKE_AGENT_SCRIPT"] = FAKE_SCRIPT;

    const repo = await createTempRepo();
    cleanups.push(() => repo.dispose());
    const scratch = await realpath(await mkdtemp(join(tmpdir(), "seance-e2e-")));
    cleanups.push(() => rm(scratch, { recursive: true, force: true }));
    const agentsDir = join(scratch, "agents");
    await cp(join(REPO_ROOT, "agents"), agentsDir, { recursive: true });

    const logger: RunnerLogger = {
      debug: () => undefined,
      info: () => undefined,
      warn: (msg, fields) => console.warn(`[e2e runner] ${msg}`, fields ?? ""),
      error: (msg, fields) => console.error(`[e2e runner] ${msg}`, fields ?? ""),
    };
    const runnerConfig = loadRunnerConfig(
      {
        SEANCE_KIRO_BIN: FAKE_KIRO_BIN,
        SEANCE_TARGET_REPO: repo.path,
        SEANCE_WORKSPACES: join(scratch, "workspaces"),
        SEANCE_AGENTS_DIR: agentsDir,
      },
      REPO_ROOT,
    );

    let runner: Runner | undefined;
    const server = createServer(
      loadConfig({
        IRCD_TCP_PORT: "0",
        IRCD_WS_PORT: String(wsPort),
        IRCD_HOST: "127.0.0.1",
        IRCD_WS_ALLOWED_ORIGINS: `http://127.0.0.1:${webPort}`,
      }),
      { error: (fields, message) => console.error(`[e2e ircd] ${message}`, fields), debug: () => undefined },
      { inviteResolver: (t, c, i) => runner?.inviteResolver(t, c, i) ?? false },
    );
    const created = createRunner({
      host: createIrcHost(server),
      config: runnerConfig,
      logger,
      clock: realClock,
      bindHost: "127.0.0.1",
      childEnv: () => Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("FAKE_AGENT_"))),
    });
    runner = created;
    cleanups.push(async () => {
      await server.stop();
    });
    cleanups.push(async () => {
      await created.shutdown();
    });
    await created.start();
    await server.start();

    const webEnv: NodeJS.ProcessEnv = {
      ...process.env,
      NEXT_PUBLIC_IRCD_WS_URL: `ws://127.0.0.1:${wsPort}`,
      NEXT_TELEMETRY_DISABLED: "1",
      NODE_ENV: "production",
      // pixel-match R13.5: the e2e build includes the fixture route and goes to its own distDir, so a
      // normal `pnpm build` (.next) never contains it.
      SEANCE_E2E_FIXTURES: "1",
      SEANCE_DIST_DIR: ".next-e2e",
    };
    delete webEnv["FAKE_AGENT_SCRIPT"];

    const build = launch("next build", ["build", "--webpack"], webEnv);
    cleanups.push(() => stopProcess(build));
    await runToCompletion(build, BUILD_TIMEOUT_MS);

    const web = launch("next start", ["start", "-p", String(webPort), "-H", "127.0.0.1"], webEnv);
    cleanups.push(() => stopProcess(web));
    await waitForHttp(`http://127.0.0.1:${webPort}/`, web, START_TIMEOUT_MS);

    return teardown;
  } catch (error) {
    await teardown().catch((e: unknown) => console.error("e2e teardown after failed setup:", e));
    throw error;
  }
}
