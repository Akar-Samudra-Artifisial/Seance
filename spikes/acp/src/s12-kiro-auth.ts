// Spike S12 part 2 (agent-sandbox task 0.2, "run on EC2"): does kiro-cli work inside the real
// sandbox image with the login state staged from a read-only mount, a read-only root and no
// KIRO_API_KEY? One prompt ("Say OK."), at most two in total.
// Run on Linux with rootless Podman 5:
//   S12_IMAGE=localhost/seance-agent@sha256:<digest> S12_AUTH_DIR=$HOME/.local/share/kiro-cli \
//     pnpm --filter @seance/spike-acp s12-auth
// Never reads .env; never uses --trust-all-tools; the agents dir and worktree are temporary.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as F from "../../../apps/runner/src/sandbox/flags.ts";
import { AcpClient, isObject, type JsonObject } from "./acp-client.ts";

const PODMAN = process.env["SEANCE_PODMAN_BIN"] ?? "podman";
const IMAGE = process.env["S12_IMAGE"];
const AUTH = process.env["S12_AUTH_DIR"];
const MODEL = process.env["SPIKE_MODEL"] ?? "claude-haiku-5.5";
if (IMAGE === undefined || IMAGE === "" || AUTH === undefined || AUTH === "") {
  console.error("set S12_IMAGE (name@sha256:<digest>, built from sandbox/Dockerfile) and S12_AUTH_DIR");
  process.exit(2);
}
const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(HERE, "out");
mkdirSync(OUT, { recursive: true });

const temps: string[] = [];
const agentsDir = realpathSync(mkdtempSync(join(tmpdir(), "seance-s12-agents-")));
const root = realpathSync(mkdtempSync(join(tmpdir(), "seance-s12-ws-")));
temps.push(agentsDir, root);
const worktree = join(root, "dev");
mkdirSync(worktree);
execFileSync("git", ["init", "-q"], { cwd: worktree });
mkdirSync(join(agentsDir, ".kiro", "agents"), { recursive: true });
writeFileSync(
  join(agentsDir, ".kiro", "agents", "s12-probe.json"),
  JSON.stringify({ name: "s12-probe", description: "S12 sandbox probe", prompt: "Reply with exactly: OK", mcpServers: {}, tools: ["read"], allowedTools: [], resources: [], includeMcpJson: false, model: MODEL }),
);

// S12_HOME_NOEXEC=1 mounts /home/agent with noexec, to learn whether kiro-cli needs it executable
// (review finding 5); the answer decides TMPFS_HOME in apps/runner/src/sandbox/flags.ts.
const homeTmpfs = process.env["S12_HOME_NOEXEC"] === "1" ? F.TMPFS_HOME.replace(":rw,", ":rw,noexec,") : F.TMPFS_HOME;
const mount = (src: string, dst: string, ro: boolean): string =>
  `--mount=type=bind,src=${src},dst=${dst},${ro ? F.MOUNT_RO : F.MOUNT_RW},${F.MOUNT_PROPAGATION},${F.MOUNT_NOSUID},${F.MOUNT_NODEV},${F.MOUNT_RELABEL_SHARED}`;
// The production flag set of apps/runner/src/sandbox/podman-args.ts, without KIRO_API_KEY.
const args = [
  "run", "-i", "--rm", `--name=seance-s12-${process.pid}`, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
  "--pids-limit=256", "--memory=2g", "--memory-swap=2g", "--cpus=2", `--user=${F.USER}`, `--userns=${F.USERNS}`,
  "--pull=never", "--http-proxy=false", "--no-hosts", "--log-driver=none", "--timeout=600", `--stop-timeout=${F.STOP_TIMEOUT_S}`,
  `--hostname=${F.HOSTNAME}`, `--workdir=${agentsDir}`, `--network=${F.NETWORK}`, `--tmpfs=${F.TMPFS_TMP}`, `--tmpfs=${homeTmpfs}`,
  mount(worktree, worktree, false), mount(agentsDir, agentsDir, true), mount(realpathSync(AUTH), F.AUTH_MOUNT_POINT, true),
  "-e", `HOME=${F.CONTAINER_HOME}`, "-e", `TMPDIR=${F.CONTAINER_TMP}`,
  IMAGE, "acp", "--agent", "s12-probe", "--model", MODEL,
];
// podman inherits this process's environment, but only the `-e` names above reach the container.
const c = new AcpClient({ command: PODMAN, args, cwd: agentsDir, logPath: join(OUT, "S12-kiro-auth.jsonl.log") });

try {
  console.log(`[S12-auth] ${PODMAN} run -i ... ${IMAGE} acp --agent s12-probe (no KIRO_API_KEY, auth staged from ${F.AUTH_MOUNT_POINT})`);
  await c.request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "seance-spike-s12", version: "0.0.0" } });
  const sess: JsonObject = await c.request("session/new", { cwd: worktree, mcpServers: [] });
  const modes = isObject(sess["modes"]) ? sess["modes"] : {};
  console.log(`  currentModeId=${String(modes["currentModeId"] ?? null)} (want s12-probe)`);
  let text = "";
  c.onNotification((method, params) => {
    const u = params["update"];
    if (method === "session/update" && isObject(u) && u["sessionUpdate"] === "agent_message_chunk" && isObject(u["content"])) {
      text += String(u["content"]["text"] ?? "");
    }
  });
  const r = await c.request("session/prompt", { sessionId: sess["sessionId"] ?? "", prompt: [{ type: "text", text: "Say OK." }] });
  console.log(`  prompt answered: stopReason=${String(r["stopReason"])}, reply=${JSON.stringify(text.trim().slice(0, 80))} (1 prompt)`);
} catch (e) {
  console.log(`  FAILED: ${(e as Error).message}`);
} finally {
  await c.close();
  for (const d of temps) rmSync(d, { recursive: true, force: true });
}
