// agent-sandbox Requirement 1: the podman variables, validated strictly.
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, loadRunnerConfig, validateRunnerPaths } from "../src/config.js";
import type { EnvSource, PodmanSandboxConfig } from "../src/config.js";
import { createTempRepo, type TempRepo } from "./fixtures/temp-repo.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const BASE: EnvSource = {
  SEANCE_TARGET_REPO: "/repo",
  SEANCE_WORKSPACES: "/ws",
  SEANCE_SANDBOX: "podman",
  SEANCE_SANDBOX_IMAGE: `localhost/seance-agent@${DIGEST}`,
  SEANCE_SANDBOX_AUTH_DIR: "/auth",
};

const load = (extra: EnvSource = {}, base: EnvSource = BASE) => loadRunnerConfig({ ...base, ...extra }, "/cwd");

function errorOf(extra: EnvSource, base: EnvSource = BASE): ConfigError {
  try {
    load(extra, base);
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return err as ConfigError;
  }
  throw new Error("expected a ConfigError");
}

const podman = (extra: EnvSource = {}): PodmanSandboxConfig => {
  const s = load(extra).sandbox;
  if (s.mode !== "podman") throw new Error("expected podman mode");
  return s;
};

describe("SEANCE_SANDBOX (1.1)", () => {
  it.each([undefined, "", "none"])("%j means none", (value) => {
    const env: EnvSource = { SEANCE_TARGET_REPO: "/r", SEANCE_WORKSPACES: "/w", SEANCE_SANDBOX: value };
    expect(loadRunnerConfig(env, "/cwd").sandbox).toEqual({ mode: "none" });
  });

  it("rejects any other value, naming the variable and the value", () => {
    const err = errorOf({ SEANCE_SANDBOX: "docker" });
    expect(err.variable).toBe("SEANCE_SANDBOX");
    expect(err.message).toContain('"docker"');
  });

  it("does not read the podman variables in none mode", () => {
    const env: EnvSource = { SEANCE_TARGET_REPO: "/r", SEANCE_WORKSPACES: "/w", SEANCE_SANDBOX_MEMORY: "lots" };
    expect(loadRunnerConfig(env, "/cwd").sandbox.mode).toBe("none");
  });
});

describe("podman defaults (1.2)", () => {
  it("applies the documented defaults", () => {
    expect(podman()).toEqual({
      mode: "podman",
      podmanBin: "podman",
      image: `localhost/seance-agent@${DIGEST}`,
      authDir: "/auth",
      memory: "2g",
      cpus: "2",
      pids: 256,
      timeoutS: 86_400,
      kiroBin: "kiro-cli",
      egressProbes: ["1.1.1.1:443"],
      blockedCidrs: [],
      ignored: [],
    });
  });
});

describe("value rules (1.3)", () => {
  it.each([
    ["SEANCE_SANDBOX_MEMORY", "512m", true],
    ["SEANCE_SANDBOX_MEMORY", "4G", true],
    ["SEANCE_SANDBOX_MEMORY", "0g", false],
    ["SEANCE_SANDBOX_MEMORY", "2gb", false],
    ["SEANCE_SANDBOX_MEMORY", "2", false],
    ["SEANCE_SANDBOX_CPUS", "0.5", true],
    ["SEANCE_SANDBOX_CPUS", "64", true],
    ["SEANCE_SANDBOX_CPUS", "0", false],
    ["SEANCE_SANDBOX_CPUS", "64.5", false],
    ["SEANCE_SANDBOX_CPUS", "-1", false],
    ["SEANCE_SANDBOX_CPUS", "1e1", false],
    ["SEANCE_SANDBOX_PIDS", "16", true],
    ["SEANCE_SANDBOX_PIDS", "4096", true],
    ["SEANCE_SANDBOX_PIDS", "15", false],
    ["SEANCE_SANDBOX_PIDS", "4097", false],
    ["SEANCE_SANDBOX_PIDS", "1.5", false],
    ["SEANCE_SANDBOX_TIMEOUT_S", "60", true],
    ["SEANCE_SANDBOX_TIMEOUT_S", "604800", true],
    ["SEANCE_SANDBOX_TIMEOUT_S", "59", false],
    ["SEANCE_SANDBOX_TIMEOUT_S", "604801", false],
    ["SEANCE_SANDBOX_BLOCKED_CIDRS", "10.0.0.0/16", true],
    ["SEANCE_SANDBOX_BLOCKED_CIDRS", "10.0.0.0/16, 172.31.0.0/16", true],
    ["SEANCE_SANDBOX_BLOCKED_CIDRS", "10.0.0.0", false],
    ["SEANCE_SANDBOX_BLOCKED_CIDRS", "10.0.0.0/33", false],
    ["SEANCE_SANDBOX_BLOCKED_CIDRS", "10.0.0.0/16,", false],
    ["SEANCE_SANDBOX_BLOCKED_CIDRS", "fd00::/8", false],
    ["SEANCE_SANDBOX_EGRESS_PROBES", "1.1.1.1:443,8.8.8.8:80", true],
    ["SEANCE_SANDBOX_EGRESS_PROBES", "1.1.1.1", false],
    ["SEANCE_SANDBOX_EGRESS_PROBES", "256.1.1.1:443", false],
    ["SEANCE_SANDBOX_EGRESS_PROBES", "1.1.1.1:0", false],
    ["SEANCE_SANDBOX_EGRESS_PROBES", "example.com:443", false],
    ["SEANCE_SANDBOX_EGRESS_PROBES", Array.from({ length: 9 }, () => "1.1.1.1:443").join(","), false],
  ])("%s=%j accepted: %s", (name, value, ok) => {
    if (ok) {
      expect(() => load({ [name]: value })).not.toThrow();
    } else {
      expect(errorOf({ [name]: value }).variable).toBe(name);
    }
  });
});

describe("credentials (1.4, decision 2)", () => {
  it("marks SEANCE_KIRO_BIN as ignored, but not KIRO_API_KEY, which is forwarded (1.7)", () => {
    expect(podman({ KIRO_API_KEY: "k", SEANCE_KIRO_BIN: "/opt/kiro" }).ignored).toEqual(["SEANCE_KIRO_BIN"]);
  });
});

// Review item 1: /tmp and /home/agent are noexec, so kiro-cli must come from the image.
describe("SEANCE_SANDBOX_KIRO_BIN stays runnable (noexec mounts)", () => {
  it.each(["kiro-cli", "kiro.v3", "/usr/local/bin/kiro-cli", "/opt/kiro/bin/kiro-cli", "/home/agentx/kiro", "/tmpfiles/kiro"])("accepts %j", (v) => {
    expect(podman({ SEANCE_SANDBOX_KIRO_BIN: v }).kiroBin).toBe(v);
  });

  it.each([
    "/home/agent/bin/kiro-cli",
    "/home/agent",
    "/tmp/kiro-cli",
    "/tmp",
    "/run/seance/auth/kiro-cli",
    "/usr/../home/agent/kiro",
    "/usr/local//bin/kiro",
    "bin/kiro-cli",
    "./kiro-cli",
    "../kiro-cli",
    "kiro cli",
    "/usr/local/bin/kiro,cli",
  ])("refuses %j and names the variable", (v) => {
    expect(errorOf({ SEANCE_SANDBOX_KIRO_BIN: v }).variable).toBe("SEANCE_SANDBOX_KIRO_BIN");
  });
});

describe("unsafe characters (1.5)", () => {
  it.each([
    ["SEANCE_SANDBOX_AUTH_DIR", "/a,ro=false"],
    ["SEANCE_SANDBOX_AUTH_DIR", '/a"b'],
    ["SEANCE_SANDBOX_AUTH_DIR", "/a\nb"],
    ["SEANCE_PODMAN_BIN", "/bin/pod,man"],
    ["SEANCE_WORKSPACES", "/ws,dst=/"],
    ["SEANCE_AGENTS_DIR", "/agents\rx"],
  ])("%s=%j is refused", (name, value) => {
    expect(errorOf({ [name]: value }).variable).toBe(name);
  });
});

describe("image pinned by digest (1.8, decision 5)", () => {
  it.each([
    "localhost/seance-agent:latest",
    "seance-agent",
    `sha256:${"a".repeat(64)}`,
    `-x@${DIGEST}`,
    `Seance@${DIGEST}`,
    `seance@sha256:${"a".repeat(63)}`,
  ])("refuses %j and says how to read the digest", (image) => {
    const err = errorOf({ SEANCE_SANDBOX_IMAGE: image });
    expect(err.variable).toBe("SEANCE_SANDBOX_IMAGE");
    expect(err.message).toContain("podman image inspect");
  });

  it("accepts a registry with a port", () => {
    expect(podman({ SEANCE_SANDBOX_IMAGE: `registry.local:5000/team/agent@${DIGEST}` }).image).toContain("5000");
  });
});

describe("headless (1.6)", () => {
  it("cannot be sandboxed", () => {
    const err = errorOf({ SEANCE_HARNESS: "headless" });
    expect(err.variable).toBe("SEANCE_HARNESS");
    expect(err.message).toContain("cannot be sandboxed");
  });
});

describe("validateRunnerPaths with podman", () => {
  let repo: TempRepo | undefined;
  let dir: string | undefined;
  afterEach(async () => {
    await repo?.dispose();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    repo = undefined;
    dir = undefined;
  });

  it("realpaths the auth dir and refuses one that is not a directory", async () => {
    repo = await createTempRepo();
    dir = await realpath(await mkdtemp(join(tmpdir(), "seance-sbx-cfg-")));
    const env = { ...BASE, SEANCE_TARGET_REPO: repo.path, SEANCE_WORKSPACES: join(dir, "ws"), SEANCE_AGENTS_DIR: dir };
    const ok = await validateRunnerPaths(loadRunnerConfig({ ...env, SEANCE_SANDBOX_AUTH_DIR: `${dir}/.` }, "/cwd"));
    expect(ok.sandbox.mode === "podman" ? ok.sandbox.authDir : "").toBe(dir);

    await writeFile(join(dir, "file"), "x");
    const err = await validateRunnerPaths(loadRunnerConfig({ ...env, SEANCE_SANDBOX_AUTH_DIR: join(dir, "file") }, "/cwd")).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as ConfigError).variable).toBe("SEANCE_SANDBOX_AUTH_DIR");
  });
});
