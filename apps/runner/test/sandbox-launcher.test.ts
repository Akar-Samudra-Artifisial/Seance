// agent-sandbox Requirements 3, 7.7, 10: preflight failure kinds and the remove / sweep sequences.
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PodmanSandboxConfig } from "../src/config.js";
import { SandboxError, type SandboxErrorKind } from "../src/sandbox/errors.js";
import { containerNick, parsePodmanMajor, parseRootless, PodmanLauncher, type ExecResult, type PodmanExec } from "../src/sandbox/launcher.js";

const silent = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const DIGEST = `sha256:${"d".repeat(64)}`;

type Script = (args: readonly string[]) => ExecResult;

/** Records every call; answers like a healthy rootless Podman 5 unless `script` says otherwise. */
function fakeExec(script: Script = () => ({ code: 0, stdout: "", stderr: "" })): PodmanExec & { calls: string[][]; envs: Record<string, string | undefined>[] } {
  const calls: string[][] = [];
  const envs: Record<string, string | undefined>[] = [];
  return {
    calls,
    envs,
    run(_bin, args, env) {
      calls.push([...args]);
      envs.push({ ...env });
      const custom = script(args);
      if (custom.code !== 0 || custom.stdout !== "" || custom.stderr !== "") return Promise.resolve(custom);
      if (args[0] === "--version") return Promise.resolve({ code: 0, stdout: "podman version 5.2.1\n", stderr: "" });
      if (args[0] === "info") return Promise.resolve({ code: 0, stdout: '{"host":{"security":{"rootless":true}}}', stderr: "" });
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
  };
}

let base: string;
let config: PodmanSandboxConfig;
beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "seance-launcher-")));
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

const launcher = (exec: PodmanExec, patch: Partial<PodmanSandboxConfig> = {}): PodmanLauncher => {
  let n = 0;
  return new PodmanLauncher({
    config: { ...config, ...patch },
    agentsDir: join(base, "agents"),
    worktreeRoot: join(base, "ws"),
    logger: silent,
    exec,
    baseEnv: { PATH: "/usr/bin", HOME: "/home/runner", LANG: "C.UTF-8", XDG_RUNTIME_DIR: "/run/user/1000", KIRO_API_KEY: "kiro-secret", DATABASE_URL: "postgres://x" },
    random: () => (n++).toString(16).padStart(8, "0"),
  });
};

const kindOf = async (p: Promise<unknown>): Promise<SandboxErrorKind | undefined> => {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  return err instanceof SandboxError ? err.kind : undefined;
};

describe("parsers", () => {
  it("reads the major version and the rootless flag", () => {
    expect(parsePodmanMajor("podman version 5.2.1")).toBe(5);
    expect(parsePodmanMajor("podman version 4.9.3")).toBe(4);
    expect(parsePodmanMajor("garbage")).toBeUndefined();
    expect(parseRootless('{"host":{"security":{"rootless":false}}}')).toBe(false);
    expect(parseRootless("not json")).toBeUndefined();
    expect(containerNick("Al[x]")).toBe("al-x-");
  });
});

describe("preflight (3.2, 3.4)", () => {
  it("passes on a healthy host and runs the checks in order", async () => {
    const exec = fakeExec();
    await launcher(exec).preflight();
    expect(exec.calls.map((c) => c[0])).toEqual(["--version", "info", "image", "run", "stop", "rm"]);
    expect(exec.calls[2]).toEqual(["image", "exists", config.image]);
  });

  it.each<[string, Script, SandboxErrorKind]>([
    ["missing binary", () => ({ code: -1, stdout: "", stderr: "spawn podman ENOENT" }), "podman-missing"],
    ["old version", (a) => (a[0] === "--version" ? { code: 0, stdout: "podman version 4.9.3", stderr: "" } : { code: 0, stdout: "", stderr: "" }), "podman-version"],
    ["not rootless", (a) => (a[0] === "info" ? { code: 0, stdout: '{"host":{"security":{"rootless":false}}}', stderr: "" } : { code: 0, stdout: "", stderr: "" }), "not-rootless"],
    ["missing image", (a) => (a[0] === "image" ? { code: 1, stdout: "", stderr: "x" } : { code: 0, stdout: "", stderr: "" }), "image-missing"],
    ["probe loopback", (a) => (a.includes("--entrypoint=seance-probe") ? { code: 10, stdout: "", stderr: "x" } : { code: 0, stdout: "", stderr: "" }), "probe-failed"],
    ["probe metadata", (a) => (a.includes("--entrypoint=seance-probe") ? { code: 11, stdout: "", stderr: "x" } : { code: 0, stdout: "", stderr: "" }), "probe-failed"],
  ])("%s", async (_what, script, kind) => {
    expect(await kindOf(launcher(fakeExec(script)).preflight())).toBe(kind);
  });

  it("names the failing check in the probe message", async () => {
    const exec = fakeExec((a) => (a.includes("--entrypoint=seance-probe") ? { code: 11, stdout: "", stderr: "x" } : { code: 0, stdout: "", stderr: "" }));
    await expect(launcher(exec).preflight()).rejects.toThrow(/metadata endpoint/);
  });

  it("fails auth-missing when the auth dir vanished after config validation", async () => {
    await rm(join(base, "auth"), { recursive: true });
    expect(await kindOf(launcher(fakeExec()).preflight())).toBe("auth-missing");
  });

  // Review finding 4: this used to pass the egress targets only for IRCD_PUBLIC=1; every podman
  // start now checks them, so a developer's Linux box and the public host run the same probe.
  const probeOf = (calls: readonly string[][]): readonly string[] => calls.find((c) => c.includes("--entrypoint=seance-probe")) ?? [];

  it("passes the egress targets to the probe in every podman start, public or not (7.7)", async () => {
    const exec = fakeExec();
    await launcher(exec).preflight();
    expect(probeOf(exec.calls).slice(-2)).toEqual([expect.stringMatching(/^\d+$/), "1.1.1.1:443"]);
    const failing = fakeExec((a) => (a.includes("1.1.1.1:443") ? { code: 13, stdout: "", stderr: "x" } : { code: 0, stdout: "", stderr: "" }));
    await expect(launcher(failing).preflight()).rejects.toThrow(/egress allow-list/);
  });

  it("also probes one address inside each blocked CIDR and fails when it is reachable", async () => {
    const exec = fakeExec();
    await launcher(exec, { blockedCidrs: ["10.0.0.0/16", "172.31.0.0/16"], egressProbes: [] }).preflight();
    expect(probeOf(exec.calls).slice(-2)).toEqual(["10.0.0.1:443", "172.31.0.1:443"]);

    const failing = fakeExec((a) => (a.includes("10.0.0.1:443") ? { code: 13, stdout: "", stderr: "x" } : { code: 0, stdout: "", stderr: "" }));
    const err = await launcher(failing, { blockedCidrs: ["10.0.0.0/16"], egressProbes: [] }).preflight().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SandboxError);
    expect((err as SandboxError).kind).toBe("probe-failed");
    expect((err as SandboxError).message).toMatch(/SEANCE_SANDBOX_BLOCKED_CIDRS/);
  });

  it("gives podman the allow-listed environment plus XDG_RUNTIME_DIR, never KIRO_API_KEY (6.2, 6.4)", async () => {
    const exec = fakeExec();
    await launcher(exec).preflight();
    for (const env of exec.envs) {
      expect(env["KIRO_API_KEY"]).toBeUndefined();
      expect(env["DATABASE_URL"]).toBeUndefined();
      expect(env["XDG_RUNTIME_DIR"]).toBe("/run/user/1000");
    }
  });
});

describe("quickCheck (3.5)", () => {
  it("runs only the version and image checks", async () => {
    const exec = fakeExec();
    await launcher(exec).quickCheck();
    expect(exec.calls.map((c) => c[0])).toEqual(["--version", "image"]);
  });
});

describe("spec (4, 5, 6)", () => {
  it("builds a podman spec with a glossary name, forwarding names only", async () => {
    const l = launcher(fakeExec());
    const spec = await l.spec({ nick: "coder", kiroAgent: "coder", sessionCwd: join(base, "ws", "dev"), extraEnv: { FAKE_AGENT_SCRIPT: "{}", KIRO_API_KEY: "x", PATH: "/evil" } });
    expect(spec.command).toBe("podman");
    expect(spec.containerName).toMatch(/^seance-coder-[0-9a-f]{8}-00000000$/);
    expect(spec.args).toContain("FAKE_AGENT_SCRIPT");
    expect(spec.args).toContain("LANG");
    expect(spec.args.join(" ")).not.toContain("KIRO_API_KEY");
    expect(spec.args).not.toContain("PATH");
    expect(spec.env["KIRO_API_KEY"]).toBeUndefined();
    expect(spec.env["FAKE_AGENT_SCRIPT"]).toBe("{}");
    expect(l.liveNames).toEqual([spec.containerName]);
  });
});

describe("remove and sweep (10.1, 10.3, 10.4, 10.7)", () => {
  it("remove stops then removes by name, and only names it created", async () => {
    const exec = fakeExec();
    const l = launcher(exec);
    const spec = await l.spec({ nick: "coder", kiroAgent: "coder", sessionCwd: join(base, "ws", "dev") });
    await l.remove("seance-other-00000000-00000000");
    expect(exec.calls).toEqual([]);
    await l.remove(spec.containerName);
    expect(exec.calls).toEqual([
      ["stop", "-t", "2", spec.containerName],
      ["rm", "-f", "--ignore", spec.containerName],
    ]);
    expect(l.liveNames).toEqual([]);
  });

  it("a failed removal throws remove-failed and is retried by the next sweep", async () => {
    let rmFails = true;
    const exec = fakeExec((a) => (a[0] === "rm" && rmFails ? { code: 1, stdout: "", stderr: "busy" } : { code: 0, stdout: "", stderr: "" }));
    const l = launcher(exec);
    const spec = await l.spec({ nick: "coder", kiroAgent: "coder", sessionCwd: join(base, "ws", "dev") });
    expect(await kindOf(l.remove(spec.containerName))).toBe("remove-failed");
    rmFails = false;
    exec.calls.length = 0;
    expect(await l.sweep()).toBe(1);
    // The sweep lists names (finding 6), so `-q` ids are gone.
    expect(exec.calls[0]?.slice(0, 4)).toEqual(["ps", "-a", "--format", "{{.Names}}"]);
    expect(exec.calls[0]).toContain(`label=io.seance.workspaces=${l.workspacesLabel}`);
    expect(exec.calls[1]).toEqual(["rm", "-f", "--ignore", spec.containerName]);
    expect(l.liveNames).toEqual([]);
  });

  // Review finding 6: the sweep lists container names (not ids), so it can also forget the names
  // this run created; anything that is not a Séance container name is never passed to `rm`.
  it("sweep removes the names ps lists for this Worktree_Root and nothing when ps lists nothing", async () => {
    const exec = fakeExec((a) =>
      a[0] === "ps"
        ? { code: 0, stdout: "seance-x-00000000-00000000\nseance-y-0000000a-0000000b\n-f\nabc123def456\nnot-seance-1\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" },
    );
    expect(await launcher(exec).sweep()).toBe(2);
    expect(exec.calls[0]).toEqual(expect.arrayContaining(["ps", "-a", "--format", "{{.Names}}"]));
    expect(exec.calls[0]).not.toContain("-q");
    expect(exec.calls[1]).toEqual(["rm", "-f", "--ignore", "seance-x-00000000-00000000", "seance-y-0000000a-0000000b"]);
    const empty = fakeExec();
    expect(await launcher(empty).sweep()).toBe(0);
    expect(empty.calls).toHaveLength(1);
  });

  it("sweep drops the swept names from the names this run created (liveNames)", async () => {
    let listed = "";
    const exec = fakeExec((a) => (a[0] === "ps" ? { code: 0, stdout: listed, stderr: "" } : { code: 0, stdout: "", stderr: "" }));
    const l = launcher(exec);
    const a = await l.spec({ nick: "coder", kiroAgent: "coder", sessionCwd: join(base, "ws", "dev") });
    const b = await l.spec({ nick: "reviewer", kiroAgent: "reviewer", sessionCwd: join(base, "ws", "dev") });
    expect([...l.liveNames].sort()).toEqual([a.containerName, b.containerName].sort());
    listed = `${a.containerName}\n`;
    expect(await l.sweep()).toBe(1);
    expect(l.liveNames).toEqual([b.containerName]);
  });
});
