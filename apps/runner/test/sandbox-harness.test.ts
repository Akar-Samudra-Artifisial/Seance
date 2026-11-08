// agent-sandbox Requirements 8, 10, 11 with the fake podman: one container per (agent, cwd), removal
// on close, exit and dispose, and every start failure as a SandboxError without a host process.
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PodmanSandboxConfig } from "../src/config.js";
import { AcpHarness } from "../src/harness/acp-harness.js";
import type { PermissionHandler, ProcessEvent, SessionEvent } from "../src/harness/harness.js";
import type { RunnerLogger } from "../src/log.js";
import type { AgentProfile } from "../src/registry/agent-profile.js";
import { SandboxError } from "../src/sandbox/errors.js";
import { execPodman, PodmanLauncher, type PodmanExec } from "../src/sandbox/launcher.js";
import { createFakePodman, type FakePodman } from "./fixtures/fake-podman-env.js";
import { ManualClock } from "./fixtures/manual-clock.js";

const quiet: RunnerLogger = { debug() {}, info() {}, warn() {}, error() {} };
const deny: PermissionHandler = () => Promise.resolve({ decision: "reject_once" });
const DIGEST = `sha256:${"e".repeat(64)}`;
const SECRET = "kiro-secret-value-123";
const coder: AgentProfile = { nick: "coder", kiroAgent: "coder", model: "m", tools: "t", color: 3, file: "coder.json" };
const reviewer: AgentProfile = { ...coder, nick: "reviewer", kiroAgent: "reviewer", file: "reviewer.json" };

type Rig = {
  readonly harness: AcpHarness;
  readonly launcher: PodmanLauncher;
  readonly fake: FakePodman;
  readonly clock: ManualClock;
  readonly events: ProcessEvent[];
  readonly dir: (name: string) => string;
};

let base: string;
let fake: FakePodman;
const rigs: AcpHarness[] = [];

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "seance-sbx-harness-")));
  for (const d of ["agents", "auth", "ws/dev", "ws/ops", "ws/_private/coder"]) await mkdir(join(base, d), { recursive: true });
  fake = await createFakePodman();
});

afterEach(async () => {
  await Promise.all(rigs.splice(0).map((h) => h.dispose().catch(() => undefined)));
  await fake.dispose();
  await rm(base, { recursive: true, force: true });
});

function makeRig(o: { script?: object; podmanBin?: string; promptTimeoutMs?: number; exec?: PodmanExec } = {}): Rig {
  const config: PodmanSandboxConfig = {
    mode: "podman",
    podmanBin: o.podmanBin ?? fake.bin,
    image: `localhost/seance@${DIGEST}`,
    authDir: join(base, "auth"),
    memory: "2g",
    cpus: "2",
    pids: 256,
    timeoutS: 3600,
    kiroBin: "kiro-cli",
    egressProbes: ["1.1.1.1:443"],
    blockedCidrs: [],
    ignored: [],
  };
  const clock = new ManualClock();
  const launcher = new PodmanLauncher({
    config,
    agentsDir: join(base, "agents"),
    worktreeRoot: join(base, "ws"),
    logger: quiet,
    baseEnv: { ...process.env, KIRO_API_KEY: SECRET, DATABASE_URL: "postgres://user:pw@db" },
    ...(o.exec !== undefined ? { exec: o.exec } : {}),
  });
  const script = o.script ?? { turns: [{ steps: [{ chunk: "pong" }] }] };
  const harness = new AcpHarness({
    config: { kiroBin: "unused-in-podman-mode", kiroApiKey: SECRET, agentsDir: join(base, "agents") },
    logger: quiet,
    clock,
    baseEnv: process.env,
    extraEnv: () => ({ FAKE_AGENT_SCRIPT: JSON.stringify(script) }),
    sandbox: launcher,
    startTimeoutMs: 2000,
    ...(o.promptTimeoutMs !== undefined ? { promptTimeoutMs: o.promptTimeoutMs } : {}),
  });
  rigs.push(harness);
  const events: ProcessEvent[] = [];
  harness.onProcessEvent((e) => events.push(e));
  return { harness, launcher, fake, clock, events, dir: (name) => join(base, "ws", name) };
}

const runCalls = async (f: FakePodman) => (await f.calls()).filter((c) => c.args[0] === "run");
const until = async (cond: () => Promise<boolean> | boolean, what: string, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("one container per session (8.1, 8.5)", () => {
  it("runs the handshake and a streamed reply through podman run -i", async () => {
    const rig = makeRig();
    const session = await rig.harness.openSession(coder, { cwd: rig.dir("dev"), onPermission: deny });
    const chunks: string[] = [];
    session.onEvent((e: SessionEvent) => {
      if (e.kind === "message-chunk") chunks.push(e.text);
    });
    expect(await session.prompt("ping")).toEqual({ stopReason: "end_turn" });
    expect(chunks.join("")).toBe("pong");
    const [run] = await runCalls(fake);
    expect(run?.args.at(-3)).toBe("acp");
    expect(run?.args.at(-1)).toBe("coder");
    // Requirement 6.4: the credential is neither forwarded nor in argv; other host secrets neither.
    expect(run?.envNames).not.toContain("KIRO_API_KEY");
    expect(run?.envNames).not.toContain("DATABASE_URL");
    expect(run?.envNames).toEqual(expect.arrayContaining(["HOME", "TMPDIR", "FAKE_AGENT_SCRIPT"]));
    expect(JSON.stringify(run?.args)).not.toContain(SECRET);
  });

  it("gives two channels of one agent two containers; closing one leaves the other", async () => {
    const rig = makeRig();
    const dev = await rig.harness.openSession(coder, { cwd: rig.dir("dev"), onPermission: deny });
    const ops = await rig.harness.openSession(coder, { cwd: rig.dir("ops"), onPermission: deny });
    expect(await fake.live()).toHaveLength(2);
    await dev.close();
    await until(async () => (await fake.live()).length === 1, "one container left");
    expect(await ops.prompt("still there?")).toEqual({ stopReason: "end_turn" });
    const calls = await fake.calls();
    // The first run call is the #dev container (opened first).
    const devName = (await runCalls(fake))[0]?.args.find((a) => a.startsWith("--name="))?.slice("--name=".length);
    expect(devName).toBeDefined();
    expect(rig.launcher.liveNames).not.toContain(devName);
    expect(calls.some((c) => c.args[0] === "stop" && c.args.at(-1) === devName)).toBe(true);
    expect(calls.some((c) => c.args[0] === "rm" && c.args.at(-1) === devName)).toBe(true);
  });

  it("terminate and hasProcess cover every container of the agent (8.2)", async () => {
    const rig = makeRig();
    await rig.harness.openSession(coder, { cwd: rig.dir("dev"), onPermission: deny });
    await rig.harness.openSession(coder, { cwd: rig.dir("ops"), onPermission: deny });
    await rig.harness.openSession(reviewer, { cwd: rig.dir("dev"), onPermission: deny });
    expect(rig.harness.hasProcess(coder)).toBe(true);
    await rig.harness.terminate(coder);
    expect(rig.harness.hasProcess(coder)).toBe(false);
    expect(rig.harness.hasProcess(reviewer)).toBe(true);
    await until(async () => (await fake.live()).length === 1, "only the reviewer container");
  });

  it("an exit names only that container's session and removes the container (8.3, 10.2, 10.5)", async () => {
    const rig = makeRig({ script: { turns: [{ steps: [{ crash: 3 }] }] } });
    const dev = await rig.harness.openSession(coder, { cwd: rig.dir("dev"), onPermission: deny });
    await rig.harness.openSession(coder, { cwd: rig.dir("ops"), onPermission: deny });
    await expect(dev.prompt("crash please")).rejects.toThrow();
    await until(() => rig.events.some((e) => e.kind === "exited"), "the exit event");
    const exit = rig.events.find((e) => e.kind === "exited");
    expect(exit?.kind === "exited" ? exit.sessionIds : undefined).toEqual([dev.id]);
    await until(async () => (await fake.live()).length === 1, "the crashed container removed");
  });

  it("a hung agent is killed and its container removed (10.2)", async () => {
    const rig = makeRig({ script: { turns: [{ steps: [{ gate: "never" }] }] }, promptTimeoutMs: 1000 });
    const dev = await rig.harness.openSession(coder, { cwd: rig.dir("dev"), onPermission: deny });
    const turn = dev.prompt("hang").catch((e: unknown) => e);
    await until(() => true, "tick");
    rig.clock.advance(1000);
    expect(await turn).toBeInstanceOf(Error);
    expect(rig.events.some((e) => e.kind === "hung")).toBe(true);
    await until(async () => (await fake.live()).length === 0, "the hung container removed");
  });

  it("a private session gets its own container with the private directory (8.5)", async () => {
    const rig = makeRig();
    await rig.harness.openSession(coder, { cwd: join(base, "ws", "_private", "coder"), onPermission: deny });
    const [run] = await runCalls(fake);
    expect(run?.args.find((a) => a.startsWith("--mount=") && a.includes("_private"))).toMatch(/relabel=private$/);
  });

  it("dispose removes every container and sweeps by label (10.4)", async () => {
    const rig = makeRig();
    await rig.harness.openSession(coder, { cwd: rig.dir("dev"), onPermission: deny });
    await rig.harness.openSession(reviewer, { cwd: rig.dir("ops"), onPermission: deny });
    await rig.harness.dispose();
    expect(await fake.live()).toEqual([]);
    expect((await fake.calls()).at(-1)?.args.slice(0, 4)).toEqual(["ps", "-a", "--format", "{{.Names}}"]);
  });
});

describe("fail closed (3.5, 3.6, 11.1 to 11.3)", () => {
  const failure = async (rig: Rig, cwd = rig.dir("dev")): Promise<SandboxError> => {
    const err = await rig.harness.openSession(coder, { cwd, onPermission: deny }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxError);
    return err as SandboxError;
  };

  it("a bogus podman binary: podman-missing, nothing started", async () => {
    const rig = makeRig({ podmanBin: join(base, "no-such-podman") });
    expect((await failure(rig)).kind).toBe("podman-missing");
    expect(rig.harness.hasProcess(coder)).toBe(false);
  });

  it("a missing image: image-missing, no run", async () => {
    await fake.setMode(["no-image"]);
    const rig = makeRig();
    expect((await failure(rig)).kind).toBe("image-missing");
    expect(await runCalls(fake)).toEqual([]);
  });

  it.each([125, 126, 127])("podman run exit %i before initialize: start-failed with a scrubbed stderr tail", async (code) => {
    await fake.setMode([`run-exit=${code}`]);
    const rig = makeRig();
    const err = await failure(rig);
    expect(err.kind).toBe("start-failed");
    expect(err.detail).toContain("<path>");
    expect(err.detail).not.toContain("/home/runner");
    expect(rig.harness.hasProcess(coder)).toBe(false);
  });

  it("a container that never answers: start-timeout, killed and removed", async () => {
    await fake.setMode(["slow-start"]);
    const rig = makeRig();
    const pending = rig.harness.openSession(coder, { cwd: rig.dir("dev"), onPermission: deny }).catch((e: unknown) => e);
    await until(async () => (await fake.live()).length === 1, "the slow container");
    rig.clock.advance(2000);
    const err = await pending;
    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).kind).toBe("start-timeout");
    await until(async () => (await fake.live()).length === 0, "the slow container removed");
  });

  it("a session directory outside the workspaces root: invalid-input, no run", async () => {
    const rig = makeRig();
    expect((await failure(rig, join(base, "agents"))).kind).toBe("invalid-input");
    expect(await runCalls(fake)).toEqual([]);
  });
});

// Review finding 2 (MAJOR): concurrent opens for one (agent, cwd) must not start two containers.
describe("one open per (agent, cwd) (review finding 2)", () => {
  it("two concurrent opens share one container and one session", async () => {
    const rig = makeRig();
    const [a, b] = await Promise.all([
      rig.harness.openSession(coder, { cwd: rig.dir("dev"), onPermission: deny }),
      rig.harness.openSession(coder, { cwd: rig.dir("dev"), onPermission: deny }),
    ]);
    expect(b).toBe(a);
    expect(await runCalls(fake)).toHaveLength(1);
    expect(await fake.live()).toHaveLength(1);
    expect(await a.prompt("ping")).toEqual({ stopReason: "end_turn" });
  });

  it("a later open of a (agent, cwd) whose container is not retired is refused, and starts nothing", async () => {
    const rig = makeRig();
    await rig.harness.openSession(coder, { cwd: rig.dir("dev"), onPermission: deny });
    const err = await rig.harness.openSession(coder, { cwd: rig.dir("dev"), onPermission: deny }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxError);
    expect(await runCalls(fake)).toHaveLength(1);
    expect(await fake.live()).toHaveLength(1);
  });

  it("after the container is retired the same (agent, cwd) opens again", async () => {
    const rig = makeRig();
    const first = await rig.harness.openSession(coder, { cwd: rig.dir("dev"), onPermission: deny });
    await first.close();
    const again = await rig.harness.openSession(coder, { cwd: rig.dir("dev"), onPermission: deny });
    expect(again.id).toBeDefined();
    expect(await runCalls(fake)).toHaveLength(2);
  });

  it("other cwds and other agents are not serialized against each other", async () => {
    const rig = makeRig();
    const sessions = await Promise.all([
      rig.harness.openSession(coder, { cwd: rig.dir("dev"), onPermission: deny }),
      rig.harness.openSession(coder, { cwd: rig.dir("ops"), onPermission: deny }),
      rig.harness.openSession(reviewer, { cwd: rig.dir("dev"), onPermission: deny }),
    ]);
    expect(new Set(sessions).size).toBe(3);
    expect(await fake.live()).toHaveLength(3);
  });

  it("a failed shared open fails both callers and leaves the key usable", async () => {
    await fake.setMode(["run-exit=125"]);
    const rig = makeRig();
    const results = await Promise.all(
      [0, 1].map(() => rig.harness.openSession(coder, { cwd: rig.dir("dev"), onPermission: deny }).catch((e: unknown) => e)),
    );
    for (const r of results) expect(r).toBeInstanceOf(SandboxError);
    expect(await runCalls(fake)).toHaveLength(1);
    await fake.setMode([]);
    const ok = await rig.harness.openSession(coder, { cwd: rig.dir("dev"), onPermission: deny });
    expect(ok.id).toBeDefined();
  });
});

// Review finding 3 (MAJOR): shutdown must not leave a container started by an in-flight open.
describe("dispose racing an open (review finding 3)", () => {
  it("an open in flight when dispose starts is retired before dispose resolves", async () => {
    await fake.setMode(["slow-start"]); // the container exists but never answers initialize
    const rig = makeRig();
    const pending = rig.harness.openSession(coder, { cwd: rig.dir("dev"), onPermission: deny }).catch((e: unknown) => e);
    await until(async () => (await fake.live()).length === 1, "the container of the open in flight");
    await rig.harness.dispose();
    expect(await fake.live()).toEqual([]); // gone before dispose resolved
    expect(await pending).toBeInstanceOf(Error);
    expect(rig.launcher.liveNames).toEqual([]);
  });

  it("an open that is still in its pre-flight checks when dispose starts creates no container", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let held = false;
    const exec: PodmanExec = {
      async run(bin, args, env) {
        if (args[0] === "image" && !held) {
          held = true;
          await gate; // dispose() runs while this check is pending
        }
        return execPodman.run(bin, args, env);
      },
    };
    const rig = makeRig({ exec });
    const pending = rig.harness.openSession(coder, { cwd: rig.dir("dev"), onPermission: deny }).catch((e: unknown) => e);
    await until(() => held, "the open to reach its image check");
    const disposing = rig.harness.dispose();
    release();
    await disposing;
    expect(await pending).toBeInstanceOf(Error);
    expect(await runCalls(fake)).toEqual([]);
    expect(await fake.live()).toEqual([]);
    expect(rig.launcher.liveNames).toEqual([]);
  });

  it("openSession rejects once dispose has started, without touching podman", async () => {
    const rig = makeRig();
    await rig.harness.dispose();
    const before = (await fake.calls()).length;
    const err = await rig.harness.openSession(coder, { cwd: rig.dir("dev"), onPermission: deny }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/shutting down|disposed/);
    expect((await fake.calls()).length).toBe(before);
  });

  it("an open that finishes after dispose started does not hand out a session", async () => {
    const rig = makeRig();
    const pending = rig.harness.openSession(coder, { cwd: rig.dir("dev"), onPermission: deny }).catch((e: unknown) => e);
    await rig.harness.dispose();
    const result = await pending;
    expect(result).toBeInstanceOf(Error);
    expect(await fake.live()).toEqual([]);
    expect(rig.launcher.liveNames).toEqual([]);
  });
});
