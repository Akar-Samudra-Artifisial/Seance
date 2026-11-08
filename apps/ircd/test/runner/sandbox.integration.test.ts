// agent-sandbox Requirement 12.4 to 12.6 (task 8.4): the Fake_Agent inside a real rootless Podman
// container, through the in-process ircd and the real runner. Skipped, with the reason in every
// title, on hosts without rootless Podman 5 or without the pinned base image (never pulls).
import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeAllFixtures, ManualClock, REPO_ROOT, startIntegration } from "./integration.js";
import type { IrcTestClient } from "./integration.js";

const TEST_IMAGE_TAG = "localhost/seance-agent-test:build";
const DOCKERFILE = "apps/runner/test/fixtures/sandbox/Dockerfile";
const TIMEOUT_MS = 120_000;

const podman = (args: readonly string[]): { status: number | null; stdout: string } => {
  const r = spawnSync("podman", [...args], { encoding: "utf8", timeout: 600_000 });
  return { status: r.error === undefined ? r.status : null, stdout: r.stdout ?? "" };
};

/** Why the suite cannot run here, or undefined when it can. Computed once. */
function skipReason(): string | undefined {
  if (process.platform !== "linux") return "podman mode needs Linux";
  const info = podman(["info", "--format", "json"]);
  if (info.status !== 0) return "podman not available";
  try {
    const parsed = JSON.parse(info.stdout) as { host?: { security?: { rootless?: boolean } } };
    if (parsed.host?.security?.rootless !== true) return "podman is not rootless";
  } catch {
    return "podman info unreadable";
  }
  const from = /^FROM\s+(\S+)/m.exec(spawnSync("cat", [join(REPO_ROOT, DOCKERFILE)], { encoding: "utf8" }).stdout)?.[1];
  if (from === undefined || podman(["image", "exists", from]).status !== 0) return "pinned base image not present locally (no pull)";
  return undefined;
}

const reason = skipReason();
const available = reason === undefined;
const title = (t: string): string => (available ? t : `${t} (skipped: ${reason ?? ""})`);

let imageRef = "";
let authDir = "";
let pump: ReturnType<typeof setInterval> | undefined;

beforeAll(() => {
  if (!available) return;
  const build = spawnSync("podman", ["build", "--pull=never", "-q", "-t", TEST_IMAGE_TAG, "-f", DOCKERFILE, "."], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 600_000,
  });
  if (build.status !== 0) throw new Error(`test image build failed: ${build.stderr}`);
  const digest = podman(["image", "inspect", "--format", "{{.Digest}}", TEST_IMAGE_TAG]).stdout.trim();
  imageRef = `localhost/seance-agent-test@${digest}`;
}, 600_000);

beforeAll(async () => {
  authDir = await realpath(await mkdtemp(join(tmpdir(), "seance-sbx-auth-")));
});

afterEach(async () => {
  try {
    await closeAllFixtures();
  } finally {
    if (pump !== undefined) clearInterval(pump);
    pump = undefined;
  }
}, TIMEOUT_MS);

afterAll(async () => {
  await rm(authDir, { recursive: true, force: true });
});

async function scene(steps: readonly Readonly<Record<string, unknown>>[], env: Readonly<Record<string, string>> = {}) {
  const clock = new ManualClock();
  const fx = await startIntegration({
    clock,
    script: { turns: [{ steps }] },
    env: { SEANCE_SANDBOX: "podman", SEANCE_SANDBOX_IMAGE: imageRef, SEANCE_SANDBOX_AUTH_DIR: authDir, ...env },
  });
  pump = setInterval(() => clock.advance(100), 5);
  const op = await fx.connectClient("op");
  await op.join("#sbx");
  op.send("INVITE coder #sbx");
  await op.waitFor(/^:coder!\S+ JOIN :?#sbx$/i, 60_000);
  return { fx, op };
}

const reply = (op: IrcTestClient, probe: string): Promise<string> =>
  op.waitFor(new RegExp(`^:coder!\\S+ PRIVMSG #sbx :.*probe ${probe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} => `), 60_000);

const liveContainers = (): readonly string[] =>
  podman(["ps", "-a", "-q", "--filter", "label=io.seance.sandbox=1", "--filter", "label=io.seance.agent=coder"]).stdout.split(/\s+/).filter((s) => s !== "");

describe("agent sandbox with real rootless Podman", () => {
  it.skipIf(!available)(
    title("runs the handshake and a reply through podman run -i, isolated (CapEff 0, NoNewPrivs, not root)"),
    async () => {
      const { op } = await scene([{ probe: "status" }]);
      op.send("PRIVMSG #sbx :coder: status");
      const line = await reply(op, "status");
      expect(line).toContain("CapEff=0000000000000000");
      expect(line).toContain("NoNewPrivs=1");
      expect(line).not.toMatch(/Uid=0\b/);
    },
    TIMEOUT_MS,
  );

  it.skipIf(!available)(
    title("hides host secrets and KIRO_API_KEY, has no git metadata, cannot reach the metadata endpoint"),
    async () => {
      process.env["SEANCE_SECRET_CANARY"] = "canary-value";
      process.env["KIRO_API_KEY"] = "kiro-canary";
      try {
        const { op } = await scene([{ probe: "env:SEANCE_SECRET_CANARY,KIRO_API_KEY" }, { probe: "git" }, { probe: "connect:169.254.169.254:80" }]);
        op.send("PRIVMSG #sbx :coder: env");
        expect(await reply(op, "env:SEANCE_SECRET_CANARY,KIRO_API_KEY")).toContain("SEANCE_SECRET_CANARY=<unset> KIRO_API_KEY=<unset>");
        expect(await reply(op, "git")).toContain("=> failed");
        expect(await reply(op, "connect:169.254.169.254:80")).toContain("=> unreachable");
      } finally {
        delete process.env["SEANCE_SECRET_CANARY"];
        delete process.env["KIRO_API_KEY"];
      }
    },
    TIMEOUT_MS,
  );

  it.skipIf(!available)(
    title("writes in the worktree belong to the runner's user; writes elsewhere fail; an op agent's turn is committed on the host"),
    async () => {
      // `@cwd` is the session directory as the agent sees it: the same path as on the host.
      const { fx, op } = await scene([{ probe: "write:@cwd/probe.txt" }, { probe: "write:/etc/probe" }, { probe: "write:/probe" }]);
      const worktree = await realpath(join(fx.workspaces, "sbx"));
      op.send("MODE #sbx +o coder");
      await op.waitFor(/MODE #sbx \+o coder$/);
      op.send("PRIVMSG #sbx :coder: write");
      expect(await reply(op, `write:${worktree}/probe.txt`)).toContain("=> written");
      expect(await reply(op, "write:/etc/probe")).toContain("=> error");
      expect(await reply(op, "write:/probe")).toContain("=> error");
      expect((await stat(join(worktree, "probe.txt"))).uid).toBe(process.getuid?.());
      await op.waitFor(/^:ChanServ!\S+ NOTICE #sbx :coder committed [0-9a-f]{7} \(1 file\)$/, 60_000);
      const author = spawnSync("git", ["-C", fx.repo.path, "log", "-1", "--format=%an", "seance/sbx"], { encoding: "utf8" }).stdout.trim();
      expect(author).toBe("coder");
    },
    TIMEOUT_MS,
  );

  it.skipIf(!available)(
    title("a kick stops and removes the container"),
    async () => {
      const { op } = await scene([]);
      expect(liveContainers().length).toBeGreaterThan(0);
      op.send("KICK #sbx coder :bye");
      await op.waitFor(/^:\S+ KICK #sbx coder /, 30_000);
      const end = Date.now() + 30_000;
      while (liveContainers().length > 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
      expect(liveContainers()).toEqual([]);
    },
    TIMEOUT_MS,
  );

  it.skipIf(!available)(
    title("a bogus podman binary or image stops the runner at boot and starts no container"),
    async () => {
      for (const env of [{ SEANCE_PODMAN_BIN: "/nonexistent/podman" }, { SEANCE_SANDBOX_IMAGE: `localhost/none@sha256:${"0".repeat(64)}` }]) {
        const fx = await startIntegration({
          autoStart: false,
          env: { SEANCE_SANDBOX: "podman", SEANCE_SANDBOX_IMAGE: imageRef, SEANCE_SANDBOX_AUTH_DIR: authDir, ...env },
        });
        await expect(fx.runner.start()).rejects.toThrow(/podman not found|sandbox image not found/);
        expect(liveContainers()).toEqual([]);
        await fx.close();
      }
    },
    TIMEOUT_MS,
  );
});
