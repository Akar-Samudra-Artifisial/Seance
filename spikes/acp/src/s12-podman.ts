// Spike S12 part 1 (agent-sandbox task 0.1, "run on EC2"): do the Podman spellings pinned in
// apps/runner/src/sandbox/flags.ts work on this host? No Kiro, no prompts.
// Run on Linux with rootless Podman 5:
//   S12_IMAGE=localhost/seance-agent@sha256:<digest> pnpm --filter @seance/spike-acp s12
// S12_IMAGE must be built from sandbox/Dockerfile (or the test image): it needs seance-probe and nc.
// Prints one result line per check; write them into spikes/acp/FINDINGS.md section S12.
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as F from "../../../apps/runner/src/sandbox/flags.ts";

const PODMAN = process.env["SEANCE_PODMAN_BIN"] ?? "podman";
const IMAGE = process.env["S12_IMAGE"];
if (IMAGE === undefined || IMAGE === "") {
  console.error("set S12_IMAGE to an image built from sandbox/Dockerfile (name@sha256:<digest>)");
  process.exit(2);
}

const BASE = ["run", "--rm", "--pull=never", `--user=${F.USER}`, `--userns=${F.USERNS}`, "--cap-drop=ALL", "--security-opt=no-new-privileges"];
const podman = (args: readonly string[], env: NodeJS.ProcessEnv = process.env, input?: string) => {
  const t0 = performance.now();
  const r = spawnSync(PODMAN, [...args], { encoding: "utf8", env, timeout: 120_000, ...(input !== undefined ? { input } : {}) });
  return { code: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim().split("\n").at(-1) ?? "", ms: Math.round(performance.now() - t0) };
};
const result = (name: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
};
const mount = (src: string, dst: string, ro: boolean, relabel: string): string =>
  `--mount=type=bind,src=${src},dst=${dst},${ro ? F.MOUNT_RO : F.MOUNT_RW},${F.MOUNT_PROPAGATION},${F.MOUNT_NOSUID},${F.MOUNT_NODEV},${relabel}`;

const temps: string[] = [];
const temp = (prefix: string): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(d);
  return d;
};

try {
  console.log(`[S12] ${podman(["--version"]).out}; SELinux: ${spawnSync("getenforce", { encoding: "utf8" }).stdout?.trim() || "not available"}`);

  // 1. pasta: the host loopback must be unreachable through the gateway with --no-map-gw, and
  //    reachable with --map-gw (proves the probe can see the difference).
  const server = createServer((s) => s.destroy());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const probe = (network: string) => podman([...BASE, `--network=${network}`, `--entrypoint=${F.PROBE_COMMAND}`, IMAGE, String(port)]);
  const isolated = probe(F.NETWORK);
  const mapped = probe("pasta:--map-gw,--ipv4-only");
  await new Promise<void>((r) => server.close(() => r()));
  result("network --no-map-gw", isolated.code === F.PROBE_EXIT.ok, `probe exit ${String(isolated.code)} (want 0; 11 means the metadata rule is missing)`);
  result("network --map-gw (control)", mapped.code === F.PROBE_EXIT.loopback, `probe exit ${String(mapped.code)} (want 10)`);

  // 2. keep-id ownership and the mount option spelling (rw, then ro must refuse a write).
  const dir = temp("seance-s12-mnt-");
  const rw = podman([...BASE, mount(dir, dir, false, F.MOUNT_RELABEL_SHARED), "--entrypoint=sh", IMAGE, "-c", `touch ${dir}/x`]);
  const owner = rw.code === 0 ? statSync(join(dir, "x")).uid : -1;
  result("mount rw + keep-id", rw.code === 0 && owner === process.getuid?.(), `exit ${String(rw.code)}, owner ${owner} (runner ${String(process.getuid?.())}) ${rw.err}`);
  const ro = podman([...BASE, mount(dir, dir, true, F.MOUNT_RELABEL_SHARED), "--entrypoint=sh", IMAGE, "-c", `touch ${dir}/y`]);
  result("mount ro", ro.code !== 0 && ro.code !== 125, `exit ${String(ro.code)} (want a failing touch, not 125) ${ro.err}`);
  const priv = podman([...BASE, mount(dir, dir, false, F.MOUNT_RELABEL_PRIVATE), "--entrypoint=sh", IMAGE, "-c", `touch ${dir}/z`]);
  result("mount relabel=private", priv.code === 0, `exit ${String(priv.code)} ${priv.err}`);

  // 3. Two containers writing one relabel=shared directory at the same time (a channel worktree).
  const shared = temp("seance-s12-shared-");
  const both = spawnSync("sh", ["-c", [0, 1].map((i) => `${PODMAN} ${[...BASE, mount(shared, shared, false, F.MOUNT_RELABEL_SHARED), "--entrypoint=sh", IMAGE, "-c", `'sleep 1; touch ${shared}/c${i}'`].join(" ")} &`).join(" ") + " wait"], { encoding: "utf8" });
  const wrote = [0, 1].filter((i) => { try { statSync(join(shared, `c${i}`)); return true; } catch { return false; } }).length;
  result("relabel=shared by two containers", wrote === 2, `${wrote} of 2 files written (sh exit ${String(both.status)})`);

  // 4. tmpfs spelling, read-only root, --timeout.
  const tmpfs = podman([...BASE, "--read-only", `--tmpfs=${F.TMPFS_TMP}`, `--tmpfs=${F.TMPFS_HOME}`, "--entrypoint=sh", IMAGE, "-c", "touch /tmp/a /home/agent/b && ! touch /etc/c 2>/dev/null"]);
  result("tmpfs + read-only root", tmpfs.code === 0, `exit ${String(tmpfs.code)} ${tmpfs.err}`);
  const timed = podman([...BASE, "--timeout=5", "--entrypoint=sh", IMAGE, "-c", "sleep 60"]);
  result("--timeout=5", timed.ms < 20_000, `ended after ${timed.ms} ms, exit ${String(timed.code)}`);

  // 5. Environment and files the host could leak.
  const proxy = podman([...BASE, "--http-proxy=false", "--entrypoint=sh", IMAGE, "-c", 'echo "${HTTP_PROXY:-unset}"'], { ...process.env, HTTP_PROXY: "http://proxy.invalid:3128" });
  result("--http-proxy=false", proxy.out === "unset", `HTTP_PROXY inside: ${proxy.out}`);
  const hosts = podman([...BASE, "--no-hosts", "--entrypoint=sh", IMAGE, "-c", "cat /etc/hosts 2>/dev/null | wc -l"]);
  result("--no-hosts", hosts.code === 0, `/etc/hosts lines: ${hosts.out}`);

  // 6. stdio with --log-driver=none and -i (the ACP transport).
  const echo = podman([...BASE.slice(0, 1), "-i", ...BASE.slice(1), "--log-driver=none", "--entrypoint=cat", IMAGE], process.env, "ping\n");
  result("-i with --log-driver=none", echo.out === "ping", `echoed ${JSON.stringify(echo.out)}`);

  // 7. stop -t 2, then rm -f --ignore, by name.
  const name = `seance-s12-${process.pid}`;
  podman(["run", "-d", "--name", name, "--pull=never", "--entrypoint=sh", IMAGE, "-c", "trap '' TERM; sleep 60"]);
  const stop = podman(["stop", "-t", String(F.STOP_TIMEOUT_S), name]);
  const rm = podman(["rm", "-f", "--ignore", name]);
  const again = podman(["rm", "-f", "--ignore", name]);
  result("stop -t 2 + rm -f --ignore", stop.code === 0 && rm.code === 0 && again.code === 0, `stop ${stop.ms} ms, rm ${rm.ms} ms, second rm exit ${String(again.code)}`);
} finally {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
}
