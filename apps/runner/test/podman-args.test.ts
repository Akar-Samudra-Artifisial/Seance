// agent-sandbox Requirements 4 to 6: one full argv as a golden example, and the refusals.
import { describe, expect, it } from "vitest";
import { SandboxError } from "../src/sandbox/errors.js";
import * as F from "../src/sandbox/flags.js";
import { buildPodmanRunArgs, buildProbeArgs, type PodmanRunInput } from "../src/sandbox/podman-args.js";

const DIGEST = `sha256:${"b".repeat(64)}`;
const INPUT: PodmanRunInput = {
  config: {
    image: `localhost/seance-agent@${DIGEST}`,
    authDir: "/srv/seance/auth",
    memory: "2G",
    cpus: "2",
    pids: 256,
    timeoutS: 86_400,
  },
  agentsDir: "/srv/seance/agents",
  sessionCwd: "/srv/seance/workspaces/dev",
  worktreeRoot: "/srv/seance/workspaces",
  privateSession: false,
  containerName: "seance-coder-1a2b3c4d-9f8e7d6c",
  labels: { workspaces: "0123456789abcdef", agent: "coder" },
  kiroAgent: "coder",
  forwardEnv: ["LANG", "TERM"],
};

describe("buildPodmanRunArgs golden argv (4.1, 5.1, 5.7, 6.1)", () => {
  it("emits exactly the documented command", () => {
    expect(buildPodmanRunArgs(INPUT)).toEqual([
      "run",
      "-i",
      "--rm",
      "--name=seance-coder-1a2b3c4d-9f8e7d6c",
      "--label=io.seance.sandbox=1",
      "--label=io.seance.workspaces=0123456789abcdef",
      "--label=io.seance.agent=coder",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=256",
      "--memory=2g",
      "--memory-swap=2g",
      "--cpus=2",
      "--user=10001:10001",
      "--userns=keep-id:uid=10001,gid=10001",
      "--pull=never",
      "--http-proxy=false",
      "--no-hosts",
      "--log-driver=none",
      "--timeout=86400",
      "--stop-timeout=2",
      "--hostname=seance-agent",
      "--workdir=/srv/seance/agents",
      "--network=pasta:--no-map-gw,--ipv4-only",
      "--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=256m",
      "--tmpfs=/home/agent:rw,nosuid,nodev,size=256m",
      "--mount=type=bind,src=/srv/seance/workspaces/dev,dst=/srv/seance/workspaces/dev,rw,bind-propagation=rprivate,nosuid,nodev,relabel=shared",
      "--mount=type=bind,src=/srv/seance/agents,dst=/srv/seance/agents,ro,bind-propagation=rprivate,nosuid,nodev,relabel=shared",
      "--mount=type=bind,src=/srv/seance/auth,dst=/run/seance/auth,ro,bind-propagation=rprivate,nosuid,nodev,relabel=shared",
      "-e",
      "HOME=/home/agent",
      "-e",
      "TMPDIR=/tmp",
      "-e",
      "LANG",
      "-e",
      "TERM",
      `localhost/seance-agent@${DIGEST}`,
      "acp",
      "--agent",
      "coder",
    ]);
  });

  it("labels a private session directory :Z and everything else :z (5.7, D21)", () => {
    const argv = buildPodmanRunArgs({
      ...INPUT,
      sessionCwd: "/srv/seance/workspaces/_private/coder",
      privateSession: true,
    });
    const mounts = argv.filter((a) => a.startsWith("--mount="));
    expect(mounts[0]).toMatch(new RegExp(`,${F.MOUNT_RELABEL_PRIVATE}$`));
    expect(mounts.slice(1).every((m) => m.endsWith(`,${F.MOUNT_RELABEL_SHARED}`))).toBe(true);
    expect(argv.some((a) => a.includes("label=disable"))).toBe(false);
  });
});

describe("refusals (1.5, 4.5, 5.3, 6.4)", () => {
  const refuses = (patch: Partial<PodmanRunInput>): void => {
    expect(() => buildPodmanRunArgs({ ...INPUT, ...patch })).toThrow(SandboxError);
  };

  it.each(["-rf", "--privileged", "a b", "", "x".repeat(65), "ü"])("kiroAgent %j", (kiroAgent) => {
    refuses({ kiroAgent });
  });

  it.each(["KIRO_API_KEY", "PATH", "HOME", "TMPDIR", "XDG_RUNTIME_DIR", "lower", "A=B"])("forwarding %j", (name) => {
    refuses({ forwardEnv: [name] });
  });

  it("a session directory with a comma, outside the root, or the root itself", () => {
    refuses({ sessionCwd: "/srv/seance/workspaces/a,ro" });
    refuses({ sessionCwd: "/srv/other" });
    refuses({ sessionCwd: "/srv/seance/workspaces" });
  });

  it("an image that is not pinned by digest", () => {
    refuses({ config: { ...INPUT.config, image: "localhost/seance-agent:latest" } });
  });

  it("an auth dir inside the session directory", () => {
    refuses({ config: { ...INPUT.config, authDir: "/srv/seance/workspaces/dev/auth" } });
  });
});

describe("buildProbeArgs (3.2 e, 7.7)", () => {
  it("uses the production network, no mounts, and passes the extra targets", () => {
    const argv = buildProbeArgs({
      image: INPUT.config.image,
      containerName: "seance-probe-00000000-11111111",
      workspacesLabel: "0123456789abcdef",
      loopbackPort: 40123,
      extraTargets: ["1.1.1.1:443"],
    });
    expect(argv).toContain(`--network=${F.NETWORK}`);
    expect(argv).toContain("--entrypoint=seance-probe");
    expect(argv.some((a) => a.startsWith("--mount"))).toBe(false);
    expect(argv.slice(-3)).toEqual([INPUT.config.image, "40123", "1.1.1.1:443"]);
  });
});
