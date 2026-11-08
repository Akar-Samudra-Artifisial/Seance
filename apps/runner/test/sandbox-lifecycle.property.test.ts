// agent-sandbox design Properties 5 and 6: container lifecycle and fail closed, in memory.
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PodmanSandboxConfig } from "../src/config.js";
import { AcpHarness } from "../src/harness/acp-harness.js";
import type { HarnessSession, PermissionHandler } from "../src/harness/harness.js";
import type { RunnerLogger } from "../src/log.js";
import type { AgentProfile } from "../src/registry/agent-profile.js";
import { SandboxError } from "../src/sandbox/errors.js";
import { PodmanLauncher, type ExecResult, type PodmanExec } from "../src/sandbox/launcher.js";
import { MemoryAcpClient, type MemoryBehaviour } from "./fixtures/memory-acp-client.js";
import { ManualClock } from "./fixtures/manual-clock.js";

const quiet: RunnerLogger = { debug() {}, info() {}, warn() {}, error() {} };
const deny: PermissionHandler = () => Promise.resolve({ decision: "reject_once" });
const DIGEST = `sha256:${"f".repeat(64)}`;
const PODMAN = "/usr/bin/podman";
const AGENTS: readonly AgentProfile[] = ["coder", "reviewer"].map((n) => ({
  nick: n,
  kiroAgent: n,
  model: "m",
  tools: "t",
  color: 3,
  file: `${n}.json`,
}));
const CWDS = ["dev", "ops", "_private/coder"] as const;

let base: string;
beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "seance-sbx-prop-")));
  for (const d of ["agents", "auth", ...CWDS.map((c) => `ws/${c}`)]) await mkdir(join(base, d), { recursive: true });
});
afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

type Failure =
  | "ok"
  | "podman-missing"
  | "podman-version"
  | "image-missing"
  | "start-125"
  | "start-126"
  | "start-127"
  | "timeout";

/** A podman whose answers follow `failure`; `rm` and `stop` always succeed. */
function memoryPodman(failure: Failure): PodmanExec {
  return {
    run(_bin, args): Promise<ExecResult> {
      if (failure === "podman-missing") return Promise.resolve({ code: -1, stdout: "", stderr: "spawn podman ENOENT" });
      if (args[0] === "--version") {
        return Promise.resolve({ code: 0, stdout: failure === "podman-version" ? "podman version 4.9.0" : "podman version 5.1.0", stderr: "" });
      }
      if (args[0] === "image") return Promise.resolve({ code: failure === "image-missing" ? 1 : 0, stdout: "", stderr: "" });
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
  };
}

function rig(failure: Failure = "ok") {
  const config: PodmanSandboxConfig = {
    mode: "podman",
    podmanBin: PODMAN,
    image: `localhost/seance@${DIGEST}`,
    authDir: join(base, "auth"),
    memory: "1g",
    cpus: "1",
    pids: 64,
    timeoutS: 600,
    kiroBin: "kiro-cli",
    egressProbes: [],
    blockedCidrs: [],
    ignored: [],
  };
  const launcher = new PodmanLauncher({
    config,
    agentsDir: join(base, "agents"),
    worktreeRoot: join(base, "ws"),
    logger: quiet,
    exec: memoryPodman(failure),
    baseEnv: { PATH: "/usr/bin" },
  });
  const clients: MemoryAcpClient[] = [];
  const behaviour: MemoryBehaviour =
    failure === "start-125"
      ? { kind: "start-exit", code: 125 }
      : failure === "start-126"
        ? { kind: "start-exit", code: 126 }
        : failure === "start-127"
          ? { kind: "start-exit", code: 127 }
          : failure === "timeout"
            ? { kind: "silent" }
            : { kind: "ok" };
  const clock = new ManualClock();
  const harness = new AcpHarness({
    config: { kiroBin: "kiro-cli", kiroApiKey: undefined, agentsDir: join(base, "agents") },
    logger: quiet,
    clock,
    sandbox: launcher,
    startTimeoutMs: 1000,
    createClient: (o) => {
      const c = new MemoryAcpClient(o, behaviour);
      clients.push(c);
      return c;
    },
  });
  return { harness, launcher, clients, clock };
}

/** Lets removal chains (stop, rm) and exit handlers run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
};

type Op =
  | { readonly kind: "open" | "close" | "crash"; readonly agent: number; readonly cwd: number }
  | { readonly kind: "ban"; readonly agent: number };

const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constantFrom("open" as const, "close" as const, "crash" as const), agent: fc.nat({ max: 1 }), cwd: fc.nat({ max: 2 }) }),
  fc.record({ kind: fc.constant("ban" as const), agent: fc.nat({ max: 1 }) }),
);

describe("agent-sandbox lifecycle properties", () => {
  it("P5 lifecycle model", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 25 }), async (ops) => {
        const { harness, launcher, clients } = rig();
        // Model: open sessions per (agent, cwd), with the container that serves them.
        const open = new Map<string, { session: HarnessSession; client: MemoryAcpClient }>();
        const key = (a: number, c: number): string => `${a}/${c}`;
        for (const o of ops) {
          const profile = AGENTS[o.agent] as AgentProfile;
          if (o.kind === "ban") {
            await harness.terminate(profile);
            for (const k of [...open.keys()]) if (k.startsWith(`${o.agent}/`)) open.delete(k);
          } else {
            const k = key(o.agent, o.cwd);
            const entry = open.get(k);
            if (o.kind === "open" && entry === undefined) {
              const session = await harness.openSession(profile, { cwd: join(base, "ws", CWDS[o.cwd] as string), onPermission: deny });
              open.set(k, { session, client: clients.at(-1) as MemoryAcpClient });
            } else if (o.kind === "close" && entry !== undefined) {
              await entry.session.close();
              open.delete(k);
            } else if (o.kind === "crash" && entry !== undefined) {
              entry.client.crash(1);
              open.delete(k);
            }
          }
          await settle();
          // Quiescent: exactly one live container per open session, none without one.
          const expected = [...open.values()].map((e) => e.client.containerName).sort();
          expect([...launcher.liveNames].sort()).toEqual(expected);
          for (const p of AGENTS) {
            expect(harness.hasProcess(p)).toBe([...open.keys()].some((k) => k.startsWith(`${AGENTS.indexOf(p)}/`)));
          }
        }
        await harness.dispose();
        expect(launcher.liveNames).toEqual([]);
        expect(clients.every((c) => c.command === PODMAN)).toBe(true);
      }),
      { numRuns: 120 },
    );
  });

  it("P6 fail closed", async () => {
    const failures: readonly Failure[] = ["podman-missing", "podman-version", "image-missing", "start-125", "start-126", "start-127", "timeout"];
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...failures), fc.nat({ max: 1 }), fc.nat({ max: 2 }), async (failure, agent, cwd) => {
        const { harness, launcher, clients, clock } = rig(failure);
        const pending = harness
          .openSession(AGENTS[agent] as AgentProfile, { cwd: join(base, "ws", CWDS[cwd] as string), onPermission: deny })
          .then(
            () => undefined,
            (e: unknown) => e,
          );
        await settle();
        if (failure === "timeout") {
          // The start timer is only set after the open's real file-system work (realpath) is done;
          // under load a fixed number of ticks is not enough, so wait for the timer itself.
          const deadline = Date.now() + 10_000;
          while (clock.pending === 0 && Date.now() < deadline) await new Promise<void>((r) => setTimeout(r, 2));
          clock.advance(1000);
        }
        const err = await pending;
        expect(err).toBeInstanceOf(SandboxError);
        await settle();
        // No agent was reached, no host process was started, and no container is left.
        expect(clients.some((c) => c.initialized)).toBe(false);
        expect(clients.every((c) => c.command === PODMAN)).toBe(true);
        if (["podman-missing", "podman-version", "image-missing"].includes(failure)) expect(clients).toEqual([]);
        expect(launcher.liveNames).toEqual([]);
        expect(harness.hasProcess(AGENTS[agent] as AgentProfile)).toBe(false);
        await harness.dispose();
      }),
      { numRuns: 100 },
    );
  });
});
