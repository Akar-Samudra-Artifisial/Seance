import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { LogFields, RunnerLogger } from "../src/log.js";
import { AcpHarness, AgentProfileNotLoadedError } from "../src/harness/acp-harness.js";
import { HeadlessHarness } from "../src/harness/headless-harness.js";
import type {
  PermissionAnswer,
  PermissionHandler,
  ProcessEvent,
  SessionEvent,
} from "../src/harness/harness.js";
import { buildSpawnSpec } from "../src/harness/spawn.js";
import type { AgentProfile } from "../src/registry/agent-profile.js";
import type { FakeDump } from "./fixtures/fake-agent.js";
import { ManualClock } from "./fixtures/manual-clock.js";

const FAKE_KIRO = fileURLToPath(new URL("./fixtures/fake-kiro", import.meta.url));

const logger: RunnerLogger = {
  debug: (_m: string, _f?: LogFields) => undefined,
  info: (_m: string, _f?: LogFields) => undefined,
  warn: (_m: string, _f?: LogFields) => undefined,
  error: (_m: string, _f?: LogFields) => undefined,
};

const profile = (kiroAgent: string, nick = kiroAgent): AgentProfile => ({
  nick,
  kiroAgent,
  model: "fake-model",
  tools: "read",
  color: 3,
  file: `${kiroAgent}.json`,
});

const deny: PermissionHandler = () => Promise.resolve({ decision: "reject_once" });

const tempDirs: string[] = [];
const harnesses: { dispose(): Promise<void> }[] = [];

const tempDir = async (): Promise<string> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "seance-harness-")));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.dispose()));
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

interface Rig {
  readonly harness: AcpHarness;
  readonly clock: ManualClock;
  readonly dumpFile: string;
  readonly cwd: string;
  readonly events: ProcessEvent[];
  readonly dump: () => Promise<FakeDump>;
  /** Resolves with the next `exited` process event (listener is attached at call time). */
  readonly nextExit: () => Promise<Extract<ProcessEvent, { kind: "exited" }>>;
}

const makeRig = async (script: object | undefined, promptTimeoutMs?: number): Promise<Rig> => {
  const dir = await tempDir();
  const dumpFile = join(dir, "dump.json");
  const fakeEnv: Record<string, string | undefined> = { FAKE_AGENT_DUMP_FILE: dumpFile };
  if (script !== undefined) fakeEnv["FAKE_AGENT_SCRIPT"] = JSON.stringify(script);
  const clock = new ManualClock();
  const harness = new AcpHarness({
    config: { kiroBin: FAKE_KIRO, kiroApiKey: undefined, agentsDir: dir },
    logger,
    clock,
    baseEnv: process.env,
    extraEnv: () => fakeEnv,
    ...(promptTimeoutMs === undefined ? {} : { promptTimeoutMs }),
  });
  harnesses.push(harness);
  const events: ProcessEvent[] = [];
  harness.onProcessEvent((e) => events.push(e));
  return {
    harness,
    clock,
    dumpFile,
    cwd: dir,
    events,
    dump: async () => JSON.parse(await readFile(dumpFile, "utf8")) as FakeDump,
    nextExit: () =>
      new Promise((resolve) => {
        const off = harness.onProcessEvent((e) => {
          if (e.kind === "exited") {
            off();
            resolve(e);
          }
        });
      }),
  };
};

describe("buildSpawnSpec", () => {
  const base = { kiroBin: "/usr/bin/kiro-cli", agentsDir: "/srv/agents" } as const;

  it("builds `acp --agent <kiroAgent>` with the agents directory as cwd", () => {
    const spec = buildSpawnSpec(profile("coder"), { ...base, kiroApiKey: undefined }, {});
    expect(spec.command).toBe("/usr/bin/kiro-cli");
    expect(spec.args).toEqual(["acp", "--agent", "coder"]);
    expect(spec.cwd).toBe("/srv/agents");
  });

  it("never builds --trust-all-tools, with or without a key", () => {
    for (const kiroApiKey of [undefined, "", "ksk-secret"]) {
      for (const agent of ["coder", "researcher", "reviewer"]) {
        const spec = buildSpawnSpec(profile(agent), { ...base, kiroApiKey }, {});
        expect(spec.args.join(" ")).not.toContain("--trust-all-tools");
        expect(spec.args.join(" ")).not.toContain("trust");
      }
    }
  });

  it("puts KIRO_API_KEY only in env, never in args", () => {
    const spec = buildSpawnSpec(profile("coder"), { ...base, kiroApiKey: "ksk-secret" }, { PATH: "/bin" });
    expect(spec.env["KIRO_API_KEY"]).toBe("ksk-secret");
    expect(spec.env["PATH"]).toBe("/bin");
    expect(spec.args.some((a) => a.includes("ksk-secret"))).toBe(false);
    expect(spec.command).not.toContain("ksk-secret");
    expect(spec.cwd).not.toContain("ksk-secret");
  });

  it("omits KIRO_API_KEY when the key is unset or empty", () => {
    expect("KIRO_API_KEY" in buildSpawnSpec(profile("coder"), { ...base, kiroApiKey: undefined }, {}).env).toBe(false);
    expect("KIRO_API_KEY" in buildSpawnSpec(profile("coder"), { ...base, kiroApiKey: "" }, {}).env).toBe(false);
  });
});

describe("AcpHarness process and session model", () => {
  it("serves two channels from one process with two sessions", async () => {
    const rig = await makeRig(undefined);
    const coder = profile("coder");
    const [a, b] = await Promise.all([
      rig.harness.openSession(coder, { cwd: rig.cwd, onPermission: deny }),
      rig.harness.openSession(coder, { cwd: rig.cwd, onPermission: deny }),
    ]);
    expect(a.id).not.toBe(b.id);
    expect(rig.harness.hasProcess(coder)).toBe(true);
    const dump = await rig.dump();
    // One process: the dump file belongs to a single Fake_Agent that saw one initialize and both sessions.
    expect(dump.requests.filter((r) => r === "initialize")).toHaveLength(1);
    expect(dump.requests.filter((r) => r === "session/new")).toHaveLength(2);
    expect(dump.sessions).toEqual([a.id, b.id]);
    expect(rig.events).toEqual([]);
  });

  it("succeeds when the reported mode matches the requested agent and routes chunks", async () => {
    const rig = await makeRig({ turns: [{ steps: [{ chunk: "hello" }] }] });
    const session = await rig.harness.openSession(profile("coder"), { cwd: rig.cwd, onPermission: deny });
    const seen: SessionEvent[] = [];
    session.onEvent((e) => seen.push(e));
    await expect(session.prompt("hi")).resolves.toEqual({ stopReason: "end_turn" });
    expect(seen).toEqual([{ kind: "message-chunk", text: "hello" }]);
  });

  it("SIGTERM exits the process, then the next openSession respawns a fresh one", async () => {
    const rig = await makeRig(undefined);
    const coder = profile("coder");
    const first = await rig.harness.openSession(coder, { cwd: rig.cwd, onPermission: deny });
    const exit = rig.nextExit();
    await rig.harness.terminate(coder, "SIGTERM");
    const info = await exit;
    expect(info.signal).toBe("SIGTERM");
    expect(info.agent).toBe("coder");
    expect(rig.harness.hasProcess(coder)).toBe(false);
    await expect(first.prompt("late")).rejects.toThrow(/closed/);

    const second = await rig.harness.openSession(coder, { cwd: rig.cwd, onPermission: deny });
    expect(rig.harness.hasProcess(coder)).toBe(true);
    const dump = await rig.dump();
    // A fresh Fake_Agent starts its own counters and rewrites the dump file.
    expect(dump.requests).toEqual(["initialize", "session/new"]);
    expect(dump.sessions).toEqual([second.id]);
  });
});

describe("AcpHarness wrong agent mode (fail closed)", () => {
  it("rejects, SIGTERMs the process, sends no session/prompt, and respawns afterwards", async () => {
    const rig = await makeRig({ modeId: "kiro_default" });
    const coder = profile("coder");
    const exit = rig.nextExit();
    const err: unknown = await rig.harness
      .openSession(coder, { cwd: rig.cwd, onPermission: deny })
      .then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(AgentProfileNotLoadedError);
    expect((err as AgentProfileNotLoadedError).kiroAgent).toBe("coder");
    expect((err as AgentProfileNotLoadedError).actualModeId).toBe("kiro_default");

    const info = await exit;
    expect(info.signal).toBe("SIGTERM");
    expect(rig.harness.hasProcess(coder)).toBe(false);

    const dump = await rig.dump();
    expect(dump.promptCount).toBe(0);
    expect(dump.requests).not.toContain("session/prompt");

    // The next openSession spawns a fresh process (same wrong mode, so it fails again, with its own dump).
    const exit2 = rig.nextExit();
    await expect(rig.harness.openSession(coder, { cwd: rig.cwd, onPermission: deny })).rejects.toBeInstanceOf(
      AgentProfileNotLoadedError,
    );
    expect((await exit2).signal).toBe("SIGTERM");
    expect((await rig.dump()).requests).toEqual(["initialize", "session/new"]);
  });
});

describe("AcpHarness hung-agent watchdog", () => {
  const TIMEOUT = 1000;
  const tool = { kind: "edit", title: "write", path: "a.txt" } as const;

  it("is armed only while a Turn is in flight", async () => {
    const rig = await makeRig(undefined, TIMEOUT);
    const session = await rig.harness.openSession(profile("coder"), { cwd: rig.cwd, onPermission: deny });
    expect(rig.clock.pending).toBe(0);
    await session.prompt("hi");
    expect(rig.clock.pending).toBe(0);
    rig.clock.advance(TIMEOUT * 10);
    expect(rig.events).toEqual([]);
  });

  it("fires after the timeout, rejects the prompt and SIGTERMs; any frame re-arms it", async () => {
    const rig = await makeRig(
      { turns: [{ steps: [{ permission: { toolCall: tool } }, { chunk: "b" }, { permission: { toolCall: tool } }] }] },
      TIMEOUT,
    );
    const answers: ((a: PermissionAnswer) => void)[] = [];
    let wake: (() => void) | undefined;
    const untilAsks = (n: number): Promise<void> =>
      new Promise<void>((resolve) => {
        if (answers.length >= n) return resolve();
        wake = () => {
          if (answers.length >= n) resolve();
        };
      });
    const onPermission: PermissionHandler = () =>
      new Promise<PermissionAnswer>((resolve) => {
        answers.push(resolve);
        wake?.();
      });

    const coder = profile("coder");
    const session = await rig.harness.openSession(coder, { cwd: rig.cwd, onPermission });
    const exit = rig.nextExit();
    const outcome = session.prompt("go").then(
      () => undefined,
      (e: unknown) => e,
    );

    await untilAsks(1);
    expect(rig.clock.pending).toBe(1);
    rig.clock.advance(TIMEOUT - 1);
    expect(rig.events).toEqual([]);

    // The reply makes the agent send a chunk and a second request: both frames re-arm the timer at now = 999.
    answers[0]?.({ decision: "allow_once" });
    await untilAsks(2);
    rig.clock.advance(TIMEOUT - 1);
    expect(rig.events).toEqual([]); // would have fired at 1000 without the re-arm

    rig.clock.advance(1);
    expect(rig.events[0]).toEqual({ kind: "hung", agent: "coder", sessionIds: [session.id] });
    const err = await outcome;
    expect(err).toBeInstanceOf(Error);
    expect((await exit).signal).toBe("SIGTERM");
    expect(rig.harness.hasProcess(coder)).toBe(false);
    expect(rig.clock.pending).toBe(0);
  });
});

describe("HeadlessHarness", () => {
  const scriptBody = [
    "#!/bin/sh",
    'for a in "$@"; do printf "arg=%s\\n" "$a"; done',
    'printf "key=%s\\n" "${KIRO_API_KEY-unset}"',
    'printf "cwd=%s\\n" "$(pwd -P)"',
    'if [ -n "$HOLD" ]; then exec sleep 600; fi',
    "",
  ].join("\n");

  const setup = async (
    kiroApiKey: string | undefined,
    baseEnv: Record<string, string | undefined> = {},
  ): Promise<{ harness: HeadlessHarness; cwd: string; bin: string }> => {
    const dir = await tempDir();
    const bin = join(dir, "fake-kiro-chat.sh");
    await writeFile(bin, scriptBody);
    await chmod(bin, 0o755);
    const cwd = await tempDir();
    const harness = new HeadlessHarness({ kiroBin: bin, kiroApiKey, agentsDir: dir }, { PATH: "/usr/bin:/bin", ...baseEnv });
    harnesses.push(harness);
    return { harness, cwd, bin };
  };

  const run = async (
    h: HeadlessHarness,
    cwd: string,
    text: string,
  ): Promise<{ lines: string[]; stop: string }> => {
    const session = await h.openSession(profile("coder"), { cwd, onPermission: deny });
    const lines: string[] = [];
    session.onEvent((e) => {
      if (e.kind === "message-chunk") lines.push(e.text);
    });
    const res = await session.prompt(text);
    return { lines, stop: res.stopReason };
  };

  it("runs `chat --agent <kiroAgent> --no-interactive <prompt>` in the session cwd", async () => {
    const { harness, cwd } = await setup(undefined);
    const { lines, stop } = await run(harness, cwd, "hello world; $(rm -rf /)");
    expect(stop).toBe("end_turn");
    expect(lines.filter((l) => l.startsWith("arg="))).toEqual([
      "arg=chat",
      "arg=--agent",
      "arg=coder",
      "arg=--no-interactive",
      "arg=hello world; $(rm -rf /)",
    ]);
    expect(lines).toContain(`cwd=${cwd}`);
    expect(lines.join("\n")).not.toContain("--trust-all-tools");
  });

  it("passes KIRO_API_KEY only through the environment", async () => {
    const withKey = await setup("ksk-secret");
    const a = await run(withKey.harness, withKey.cwd, "x");
    expect(a.lines).toContain("key=ksk-secret");
    expect(a.lines.filter((l) => l.startsWith("arg=")).join("\n")).not.toContain("ksk-secret");

    for (const key of [undefined, ""]) {
      const without = await setup(key);
      const b = await run(without.harness, without.cwd, "x");
      expect(b.lines).toContain("key=unset");
    }
  });

  it("cancel sends SIGTERM to the running child and the prompt resolves cancelled", async () => {
    const { harness, cwd } = await setup(undefined, { HOLD: "1" });
    const session = await harness.openSession(profile("coder"), { cwd, onPermission: deny });
    let started: () => void = () => undefined;
    const ready = new Promise<void>((r) => {
      started = r;
    });
    session.onEvent((e) => {
      if (e.kind === "message-chunk" && e.text.startsWith("cwd=")) started();
    });
    const turn = session.prompt("long");
    await ready;
    session.cancel();
    await expect(turn).resolves.toEqual({ stopReason: "cancelled" });
  });

  it("terminate is a no-op and no process is ever reported", async () => {
    const { harness } = await setup(undefined);
    await expect(harness.terminate()).resolves.toBeUndefined();
    expect(harness.hasProcess(profile("coder"))).toBe(false);
  });
});
