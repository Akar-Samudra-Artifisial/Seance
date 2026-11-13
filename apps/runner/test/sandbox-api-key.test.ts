// sandbox-api-key-auth: KIRO_API_KEY reaches the podman container by name, never through argv.
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigError, loadRunnerConfig, sandboxAuthWarnings, type EnvSource, type PodmanSandboxConfig } from "../src/config.js";
import { SandboxError } from "../src/sandbox/errors.js";
import { PodmanLauncher, type ExecResult, type PodmanExec } from "../src/sandbox/launcher.js";
import { assertMountPaths } from "../src/sandbox/paths.js";
import { buildPodmanRunArgs, type PodmanRunInput } from "../src/sandbox/podman-args.js";

const DIGEST = `sha256:${"e".repeat(64)}`;
const silent = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

const INPUT: PodmanRunInput = {
  config: { image: `localhost/seance@${DIGEST}`, authDir: "/srv/seance/auth", memory: "2g", cpus: "2", pids: 256, timeoutS: 86_400, kiroBin: "kiro-cli" },
  agentsDir: "/srv/seance/agents",
  sessionCwd: "/srv/seance/workspaces/dev",
  worktreeRoot: "/srv/seance/workspaces",
  privateSession: false,
  containerName: "seance-coder-1a2b3c4d-9f8e7d6c",
  labels: { workspaces: "0123456789abcdef", agent: "coder" },
  kiroAgent: "coder",
  forwardEnv: ["LANG"],
  forwardApiKey: false,
};

const withoutAuth = (input: PodmanRunInput): PodmanRunInput => ({ ...input, config: { ...input.config, authDir: undefined } });

describe("buildPodmanRunArgs key forwarding (1.1, 1.3, 2.2)", () => {
  it("adds the name-only pair before the image when the key is forwarded", () => {
    const argv = buildPodmanRunArgs({ ...INPUT, forwardApiKey: true });
    const at = argv.indexOf("KIRO_API_KEY");
    expect(argv[at - 1]).toBe("-e");
    expect(argv.filter((a) => a === "KIRO_API_KEY")).toHaveLength(1);
    expect(at).toBeLessThan(argv.indexOf(INPUT.config.image));
    expect(argv.some((a) => a.startsWith("KIRO_API_KEY="))).toBe(false);
  });

  it("omits the pair when the key is not forwarded, leaving the argv unchanged (5.1)", () => {
    const argv = buildPodmanRunArgs(INPUT);
    expect(argv).not.toContain("KIRO_API_KEY");
    const keyed = buildPodmanRunArgs({ ...INPUT, forwardApiKey: true });
    const at = keyed.indexOf("KIRO_API_KEY");
    expect(keyed.filter((_, i) => i !== at && i !== at - 1)).toEqual(argv);
  });

  it("still refuses KIRO_API_KEY in the generic forwardEnv list (1.6)", () => {
    expect(() => buildPodmanRunArgs({ ...INPUT, forwardEnv: ["KIRO_API_KEY"] })).toThrow(SandboxError);
  });
});

describe("auth mount (3.1, 3.2, 3.5)", () => {
  it("is present when the auth dir is set and absent when it is not", () => {
    const withDir = buildPodmanRunArgs(INPUT).filter((a) => a.startsWith("--mount="));
    const noDir = buildPodmanRunArgs(withoutAuth(INPUT)).filter((a) => a.startsWith("--mount="));
    expect(withDir).toHaveLength(3);
    expect(withDir[2]).toContain("src=/srv/seance/auth,");
    expect(noDir).toHaveLength(2);
    expect(noDir.join(" ")).not.toContain("/srv/seance/auth");
  });

  it("skips the auth overlap checks when the auth dir is undefined", () => {
    expect(() => assertMountPaths({ sessionCwd: "/w/dev", worktreeRoot: "/w", agentsDir: "/agents" })).not.toThrow();
    expect(() => assertMountPaths({ sessionCwd: "/w/dev", worktreeRoot: "/w", agentsDir: "/agents", authDir: "/w/dev/x" })).toThrow(SandboxError);
  });
});

type Rec = PodmanExec & { calls: string[][]; envs: Record<string, string | undefined>[] };
function fakeExec(): Rec {
  const calls: string[][] = [];
  const envs: Record<string, string | undefined>[] = [];
  return {
    calls,
    envs,
    run(_bin, args, env): Promise<ExecResult> {
      calls.push([...args]);
      envs.push({ ...env });
      if (args[0] === "--version") return Promise.resolve({ code: 0, stdout: "podman version 5.2.1\n", stderr: "" });
      if (args[0] === "info") return Promise.resolve({ code: 0, stdout: '{"host":{"security":{"rootless":true}}}', stderr: "" });
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
  };
}

let base: string;
let config: PodmanSandboxConfig;
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "seance-apikey-")));
  await mkdir(join(base, "auth"));
  await mkdir(join(base, "agents"));
  await mkdir(join(base, "ws", "dev"), { recursive: true });
  config = {
    mode: "podman",
    podmanBin: "podman",
    image: `localhost/seance@${DIGEST}`,
    authDir: join(base, "auth"),
    memory: "2g",
    cpus: "2",
    pids: 256,
    timeoutS: 86_400,
    kiroBin: "kiro-cli",
    egressProbes: ["1.1.1.1:443"],
    blockedCidrs: [],
    ignored: [],
  };
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const launcher = (exec: PodmanExec, apiKey: string | undefined, patch: Partial<PodmanSandboxConfig> = {}): PodmanLauncher => {
  let n = 0;
  return new PodmanLauncher({
    config: { ...config, ...patch },
    agentsDir: join(base, "agents"),
    worktreeRoot: join(base, "ws"),
    logger: silent,
    exec,
    ...(apiKey !== undefined ? { apiKey } : {}),
    baseEnv: { PATH: "/usr/bin", HOME: "/home/runner", LANG: "C.UTF-8", XDG_RUNTIME_DIR: "/run/user/1000", KIRO_API_KEY: "parent-env-value" },
    random: () => (n++).toString(16).padStart(8, "0"),
  });
};
const SPEC = (): { nick: string; kiroAgent: string; sessionCwd: string } => ({ nick: "coder", kiroAgent: "coder", sessionCwd: join(base, "ws", "dev") });

// Long, marked keys (with multi-byte characters) so a substring match cannot be an accident.
const keyArb = fc
  .array(fc.constantFrom(..."abcXYZ019-_=+/\u00e9\u65e5\u672c\u8a9e\u{1F600}"), { minLength: 12, maxLength: 40 })
  .map((cs) => `kiro-key-${cs.join("")}`);

describe("PodmanLauncher key handling (1.2, 1.3, 1.4, 1.5, 2.3, 5.3)", () => {
  it("puts the key in the spawn env and keeps it out of argv", async () => {
    const spec = await launcher(fakeExec(), "sekret-value-123").spec(SPEC());
    expect(spec.env["KIRO_API_KEY"]).toBe("sekret-value-123");
    expect(spec.args.join("\n")).not.toContain("sekret-value-123");
    expect(spec.args).toContain("KIRO_API_KEY");
  });

  it("leaves KIRO_API_KEY out of env and argv without a key, even if the parent env has one", async () => {
    const spec = await launcher(fakeExec(), undefined).spec(SPEC());
    expect("KIRO_API_KEY" in spec.env).toBe(false);
    expect(spec.args).not.toContain("KIRO_API_KEY");
    const empty = await launcher(fakeExec(), "").spec(SPEC());
    expect("KIRO_API_KEY" in empty.env).toBe(false);
  });

  it("gives the key to no other podman call, and never runs podman exec", async () => {
    const exec = fakeExec();
    const l = launcher(exec, "sekret-value-123");
    await l.preflight();
    const spec = await l.spec(SPEC());
    await l.quickCheck();
    await l.remove(spec.containerName);
    await l.sweep();
    for (let i = 0; i < exec.calls.length; i++) {
      expect(exec.envs[i]?.["KIRO_API_KEY"]).toBeUndefined();
      expect(exec.calls[i]?.join("\n")).not.toContain("sekret-value-123");
      expect(exec.calls[i]?.[0]).not.toBe("exec");
    }
    expect(spec.args[0]).toBe("run");
  });

  it("skips the auth dir check in preflight when no auth dir is configured (3.4)", async () => {
    const exec = fakeExec();
    await launcher(exec, "k-value-1234", { authDir: undefined }).preflight();
    expect(exec.calls.map((c) => c[0])).toEqual(["--version", "info", "image", "run", "stop", "rm"]);
    const spec = await launcher(fakeExec(), "k-value-1234", { authDir: undefined }).spec(SPEC());
    expect(spec.args.filter((a) => a.startsWith("--mount="))).toHaveLength(2);
  });

  it("P1 key never in argv", async () => {
    await fc.assert(
      fc.asyncProperty(keyArb, fc.boolean(), async (key, withAuth) => {
        const patch = withAuth ? {} : { authDir: undefined };
        const keyed = await launcher(fakeExec(), key, patch).spec(SPEC());
        const plain = await launcher(fakeExec(), undefined, patch).spec(SPEC());
        expect(keyed.args.some((a) => a.includes(key))).toBe(false);
        expect(keyed.command.includes(key)).toBe(false);
        expect(keyed.env["KIRO_API_KEY"]).toBe(key);
        // Same argv as without the key plus exactly one name-only pair.
        const at = keyed.args.indexOf("KIRO_API_KEY");
        expect(keyed.args[at - 1]).toBe("-e");
        const rest = keyed.args.filter((_, i) => i !== at && i !== at - 1);
        expect(rest.length).toBe(plain.args.length);
      }),
      { numRuns: 40 },
    );
  });

  it("P5 no log or error carries the key, even when podman stderr echoes it", async () => {
    await fc.assert(
      fc.asyncProperty(keyArb, async (key) => {
        const seen: string[] = [];
        const note = (m: string, f?: unknown): void => {
          seen.push(m + JSON.stringify(f ?? {}));
        };
        const logger = { debug: note, info: note, warn: note, error: note };
        const exec: PodmanExec = {
          run: (_b, args) =>
            Promise.resolve(
              args[0] === "--version"
                ? { code: 0, stdout: "podman version 5.2.1", stderr: "" }
                : { code: 1, stdout: "", stderr: `KIRO_API_KEY=${key}` },
            ),
        };
        const l = new PodmanLauncher({ config, agentsDir: join(base, "agents"), worktreeRoot: join(base, "ws"), logger, exec, apiKey: key });
        const err = await l.preflight().then(
          () => undefined,
          (e: unknown) => e,
        );
        const spec = await l.spec(SPEC());
        await l.remove(spec.containerName).catch(() => undefined);
        await l.sweep();
        expect(JSON.stringify(err instanceof SandboxError ? [err.message, err.detail] : [])).not.toContain(key);
        expect(seen.join("\n")).not.toContain(key);
      }),
      { numRuns: 25 },
    );
  });
});

const ENV: EnvSource = {
  SEANCE_TARGET_REPO: "/repo",
  SEANCE_WORKSPACES: "/ws",
  SEANCE_SANDBOX: "podman",
  SEANCE_SANDBOX_IMAGE: `localhost/seance-agent@${DIGEST}`,
};
const load = (extra: EnvSource) => loadRunnerConfig({ ...ENV, ...extra }, "/cwd");
const errorOf = (extra: EnvSource): ConfigError => {
  try {
    load(extra);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err as ConfigError;
  }
  throw new Error("expected a ConfigError");
};
const clean = fc.string({ minLength: 1, maxLength: 30 }).filter((s) => !/[\0\r\n]/.test(s) && s.trim() !== "");
const blank = fc.array(fc.constantFrom(" ", "\t", "\u00a0", "\u2003", "\u3000", "\ufeff", "\v", "\f"), { minLength: 1, maxLength: 6 }).map((cs) => cs.join(""));

describe("startup credential validation (2.6, 4.1 to 4.7)", () => {
  it("fails fast naming both variables when neither credential is set", () => {
    const err = errorOf({});
    expect(err.message).toContain("SEANCE_SANDBOX_AUTH_DIR");
    expect(err.message).toContain("KIRO_API_KEY");
    expect(err.message).toContain("one of them is required");
  });

  it("accepts the key alone", () => {
    const c = load({ KIRO_API_KEY: "key-value-1" });
    expect(c.sandbox.mode === "podman" && c.sandbox.authDir).toBeUndefined();
    expect(c.kiroApiKey).toBe("key-value-1");
    expect(c.sandbox.mode === "podman" ? c.sandbox.ignored : ["x"]).toEqual([]);
    expect(sandboxAuthWarnings(c)).toEqual([]);
  });

  it("accepts the auth dir alone, without a warning", () => {
    const c = load({ SEANCE_SANDBOX_AUTH_DIR: "/auth" });
    expect(c.sandbox.mode === "podman" && c.sandbox.authDir).toBe("/auth");
    expect(sandboxAuthWarnings(c)).toEqual([]);
  });

  it("accepts both and warns once, naming both variables and not the value", () => {
    const c = load({ SEANCE_SANDBOX_AUTH_DIR: "/auth", KIRO_API_KEY: "key-value-1" });
    const w = sandboxAuthWarnings(c);
    expect(w).toHaveLength(1);
    expect(w[0]?.message).toContain("KIRO_API_KEY");
    expect(w[0]?.message).toContain("SEANCE_SANDBOX_AUTH_DIR");
    expect(w[0]?.message).toMatch(/takes precedence/);
    expect(JSON.stringify(w)).not.toContain("key-value-1");
  });

  it.each(["a\nb", "a\rb", "a\0b", "\n"])("rejects a key with a control character (%j) without echoing it", (key) => {
    const err = errorOf({ KIRO_API_KEY: key, SEANCE_SANDBOX_AUTH_DIR: "/auth" });
    expect(err.variable).toBe("KIRO_API_KEY");
    expect(err.message).not.toContain(key);
  });

  it("P7 the credential matrix decides acceptance and the warning", () => {
    fc.assert(
      fc.property(fc.option(clean, { nil: undefined }), fc.boolean(), (key, hasDir) => {
        const extra: EnvSource = { ...(key !== undefined ? { KIRO_API_KEY: key } : {}), ...(hasDir ? { SEANCE_SANDBOX_AUTH_DIR: "/auth" } : {}) };
        if (key === undefined && !hasDir) {
          expect(errorOf(extra).message).toContain("KIRO_API_KEY");
        } else {
          expect(sandboxAuthWarnings(load(extra))).toHaveLength(key !== undefined && hasDir ? 1 : 0);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("P8 a control character anywhere in the key is rejected", () => {
    fc.assert(
      fc.property(clean, clean, fc.constantFrom("\0", "\r", "\n"), (a, b, ch) => {
        const key = a + ch + b;
        const err = errorOf({ KIRO_API_KEY: key, SEANCE_SANDBOX_AUTH_DIR: "/auth" });
        expect(err.variable).toBe("KIRO_API_KEY");
        expect(err.message).not.toContain(key);
      }),
      { numRuns: 100 },
    );
  });

  it("leaves none mode unchanged (4.7)", () => {
    const c = loadRunnerConfig({ SEANCE_TARGET_REPO: "/r", SEANCE_WORKSPACES: "/w", KIRO_API_KEY: "k" }, "/cwd");
    expect(c.sandbox).toEqual({ mode: "none" });
    expect(c.kiroApiKey).toBe("k");
  });
});

describe("whitespace-only KIRO_API_KEY (Requirement 9)", () => {
  const noneMode = (key: string) => loadRunnerConfig({ SEANCE_TARGET_REPO: "/r", SEANCE_WORKSPACES: "/w", KIRO_API_KEY: key }, "/cwd");

  it("P9 whitespace-only key is unset", () => {
    fc.assert(
      fc.property(blank, clean, blank, (ws, key, pad) => {
        // Blank: unset in both modes; without an auth dir podman mode fails as if no key were set.
        expect(load({ KIRO_API_KEY: ws, SEANCE_SANDBOX_AUTH_DIR: "/auth" }).kiroApiKey).toBeUndefined();
        expect(noneMode(ws).kiroApiKey).toBeUndefined();
        expect(errorOf({ KIRO_API_KEY: ws }).message).toContain("one of them is required");
        // Not blank: kept exactly, surrounding whitespace included.
        const padded = pad + key + pad;
        expect(load({ KIRO_API_KEY: padded }).kiroApiKey).toBe(padded);
      }),
      { numRuns: 100 },
    );
  });

  it("P10 control chars beat blank check", () => {
    fc.assert(
      fc.property(blank, fc.constantFrom("\0", "\r", "\n"), (ws, ch) => {
        expect(errorOf({ KIRO_API_KEY: ws + ch + ws, SEANCE_SANDBOX_AUTH_DIR: "/auth" }).variable).toBe("KIRO_API_KEY");
      }),
      { numRuns: 100 },
    );
  });

  it("gives no warning for a blank key next to an auth dir", () => {
    expect(sandboxAuthWarnings(load({ KIRO_API_KEY: "   ", SEANCE_SANDBOX_AUTH_DIR: "/auth" }))).toEqual([]);
  });

  it("forwards no key for a blank key", async () => {
    const c = load({ KIRO_API_KEY: " \t ", SEANCE_SANDBOX_AUTH_DIR: "/auth" });
    const spec = await launcher(fakeExec(), c.kiroApiKey).spec(SPEC());
    expect(spec.args).not.toContain("KIRO_API_KEY");
    expect("KIRO_API_KEY" in spec.env).toBe(false);
  });
});
