// Regression tests for the security-review hardening of the agent runner.
import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IrcMessage } from "@seance/irc-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { allowListedEnv } from "../src/child-env.js";
import { assertInvitersConfigured, ConfigError, isLoopbackHost, loadRunnerConfig } from "../src/config.js";
import { AcpHarness } from "../src/harness/acp-harness.js";
import { buildSpawnSpec } from "../src/harness/spawn.js";
import type { RunnerLogger } from "../src/log.js";
import { AgentOutput } from "../src/output/agent-output.js";
import type { HostVirtualClient } from "../src/ports.js";
import type { AgentProfile } from "../src/registry/agent-profile.js";
import { gitEnv } from "../src/worktree/git.js";
import { ManualClock } from "./fixtures/manual-clock.js";

const SECRET = "ksk-super-secret-value";
const quiet: RunnerLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

const HOSTILE_ENV = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/x",
  LANG: "C",
  LC_ALL: "C",
  LC_TIME: "C",
  TERM: "xterm",
  TMPDIR: "/tmp",
  DATABASE_URL: "postgres://u:p@db/x",
  REDIS_URL: "redis://r",
  KIRO_API_KEY: "from-parent-env",
  AWS_SECRET_ACCESS_KEY: "aws",
  GIT_SSH_COMMAND: "evil",
  NODE_OPTIONS: "--require evil",
} as const;

describe("child environment allow-list (1)", () => {
  it("keeps only PATH, HOME, LANG, LC_*, TERM and TMPDIR", () => {
    expect(Object.keys(allowListedEnv(HOSTILE_ENV)).sort()).toEqual(
      ["HOME", "LANG", "LC_ALL", "LC_TIME", "PATH", "TERM", "TMPDIR"].sort(),
    );
  });

  it("kiro gets KIRO_API_KEY only from the config, never from the parent environment", () => {
    const base = { kiroBin: "kiro-cli", agentsDir: "/a" } as const;
    const withKey = buildSpawnSpec({ kiroAgent: "coder" }, { ...base, kiroApiKey: SECRET }, HOSTILE_ENV);
    expect(withKey.env["KIRO_API_KEY"]).toBe(SECRET);
    expect(withKey.env["DATABASE_URL"]).toBeUndefined();
    expect(withKey.env["NODE_OPTIONS"]).toBeUndefined();
    const noKey = buildSpawnSpec({ kiroAgent: "coder" }, { ...base, kiroApiKey: undefined }, HOSTILE_ENV);
    expect("KIRO_API_KEY" in noKey.env).toBe(false);
  });

  it("git gets no KIRO_API_KEY and no other secret", () => {
    const env = gitEnv(HOSTILE_ENV);
    expect(env["KIRO_API_KEY"]).toBeUndefined();
    expect(env["DATABASE_URL"]).toBeUndefined();
    expect(env["GIT_SSH_COMMAND"]).toBeUndefined();
    expect(env["PATH"]).toBe("/usr/bin:/bin");
    expect(env["GIT_TERMINAL_PROMPT"]).toBe("0");
    expect(env["LC_ALL"]).toBe("C");
  });
});

describe("AgentOutput redaction and control stripping (2)", () => {
  const make = (): { out: AgentOutput; sent: IrcMessage[]; aways: (string | undefined)[] } => {
    const sent: IrcMessage[] = [];
    const aways: (string | undefined)[] = [];
    const client: HostVirtualClient = {
      id: "c",
      virtual: true,
      send: () => undefined,
      dispatch: (m: IrcMessage) => {
        sent.push(m);
        return undefined;
      },
      onMessage: () => () => undefined,
      setAway: (t?: string) => void aways.push(t),
      close: () => undefined,
    };
    const out = new AgentOutput({
      client,
      logger: quiet,
      nick: "coder",
      user: "coder",
      host: "seance.local",
      color: 4,
      secrets: [SECRET],
    });
    return { out, sent, aways };
  };

  it("removes secrets from say, channelNotice and AWAY", () => {
    const { out, sent, aways } = make();
    out.say("#c", `the key is ${SECRET} and {"api_key":"abc123"}`);
    out.channelNotice("#c", `notice ${SECRET}`);
    out.toolStarted("#c", `running with ${SECRET}`);
    const all = [...sent.map((m) => m.params[1] ?? ""), ...aways.map((a) => a ?? "")].join("\n");
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain("abc123");
    expect(all).toContain("[REDACTED]");
  });

  it("strips every C0 control, keeping only the colour codes the runner adds", () => {
    const { out, sent } = make();
    out.say("#c", "a\x03" + "04red\x02bold\x1b[31m\x07bell\x7fdel\x0Fend\ttab");
    out.channelNotice("#c", "n\x03" + "09x\x1b\x01y");
    const say = sent[0]?.params[1] ?? "";
    expect(say).toBe("\x0304a04redbold[31mbelldelendtab\x0F");
    const notice = sent[1]?.params[1] ?? "";
    expect(notice).toBe("n09xy");
  });

  it("a secret obfuscated with control characters is still redacted", () => {
    const { out, sent } = make();
    out.say("#c", `${SECRET.slice(0, 5)}\x02${SECRET.slice(5)}`);
    expect(sent.map((m) => m.params[1] ?? "").join("")).not.toContain(SECRET);
    expect(sent[0]?.params[1]).toContain("[REDACTED]");
  });
});

describe("open invites need a loopback ircd (3)", () => {
  const cfg = (extra: Record<string, string> = {}) =>
    loadRunnerConfig({ SEANCE_TARGET_REPO: "/r", SEANCE_WORKSPACES: "/w", ...extra });

  it("recognises loopback hosts only", () => {
    for (const h of ["127.0.0.1", "127.1.2.3", "localhost", "::1", "[::1]"]) expect(isLoopbackHost(h)).toBe(true);
    for (const h of [undefined, "0.0.0.0", "::", "10.0.0.5", "example.com", "127.0.0.1.evil.com"]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });

  it("fails with a ConfigError naming SEANCE_INVITERS when unset and not on loopback", () => {
    for (const host of [undefined, "0.0.0.0", "192.168.1.5"]) {
      let caught: unknown;
      try {
        assertInvitersConfigured(cfg(), host);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect((caught as ConfigError).variable).toBe("SEANCE_INVITERS");
      expect((caught as ConfigError).message).toContain("SEANCE_INVITERS");
    }
  });

  it("passes on loopback, or when SEANCE_INVITERS is set", () => {
    expect(() => assertInvitersConfigured(cfg(), "127.0.0.1")).not.toThrow();
    expect(() => assertInvitersConfigured(cfg({ SEANCE_INVITERS: "alice" }), undefined)).not.toThrow();
  });
});

describe("kill escalation and process group (5)", () => {
  const dirs: string[] = [];
  const harnesses: AcpHarness[] = [];
  afterEach(async () => {
    await Promise.all(harnesses.splice(0).map((h) => h.dispose().catch(() => undefined)));
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  const profile: AgentProfile = {
    nick: "stubborn",
    kiroAgent: "stubborn",
    model: "m",
    tools: "read",
    color: 1,
    file: "stubborn.json",
  };

  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const until = async (cond: () => Promise<boolean> | boolean): Promise<void> => {
    for (let i = 0; i < 200; i += 1) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("condition not met in time");
  };

  it("SIGTERM that is ignored is followed by SIGKILL after killGraceMs, reaching the whole group", async () => {
    const dir = await mkdtemp(join(tmpdir(), "seance-kill-"));
    dirs.push(dir);
    const pidFile = join(dir, "child.pid");
    const bin = join(dir, "stubborn.sh");
    // Ignores SIGTERM, and leaves a SIGTERM-ignoring grandchild in the same process group.
    await writeFile(bin, `#!/bin/sh\ntrap '' TERM\nsleep 300 &\necho $! > "${pidFile}"\nwhile :; do sleep 1; done\n`);
    await chmod(bin, 0o755);
    const clock = new ManualClock();
    const harness = new AcpHarness({
      config: { kiroBin: bin, kiroApiKey: undefined, agentsDir: dir },
      logger: quiet,
      clock,
      baseEnv: { PATH: process.env["PATH"] },
      killGraceMs: 5000,
    });
    harnesses.push(harness);

    // `initialize` never answers, so openSession stays pending; the process is what matters here.
    const opening = harness.openSession(profile, { cwd: dir, onPermission: () => Promise.resolve({ decision: "reject_once" }) });
    opening.catch(() => undefined);
    await until(async () => {
      try {
        return (await readFile(pidFile, "utf8")).trim() !== "";
      } catch {
        return false;
      }
    });
    const grandchild = Number((await readFile(pidFile, "utf8")).trim());
    expect(alive(grandchild)).toBe(true);
    expect(harness.hasProcess(profile)).toBe(true);

    const terminating = harness.terminate(profile, "SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    // Still alive: SIGTERM was ignored and the grace period has not elapsed.
    expect(harness.hasProcess(profile)).toBe(true);
    expect(alive(grandchild)).toBe(true);

    clock.advance(5000);
    await terminating;
    expect(harness.hasProcess(profile)).toBe(false);
    await until(() => !alive(grandchild));
  }, 20_000);
});
