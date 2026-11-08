// Stand-in for `podman` (agent-sandbox Requirement 12.3). Run through the `fake-podman` sh launcher
// or a per-test wrapper that sets the variables below. Plain JavaScript so it starts without a build.
//
//   FAKE_PODMAN_LOG    file; one JSON line per call: { args, envNames }
//   FAKE_PODMAN_STATE  directory; one file per live container (name -> { pid, labels })
//   FAKE_PODMAN_MODE   comma list of switches:
//                      old-version | not-rootless | no-image | probe=<code> | run-exit=<code>
//                      | slow-start | rm-fail
//
// `run -i ... <image> acp --agent <name>` starts the Fake_Agent (`fake-kiro`) with an environment
// built only from the `-e` arguments plus PATH, as the container would see it.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const mode = new Set((process.env.FAKE_PODMAN_MODE ?? "").split(",").filter((s) => s !== ""));
const modeValue = (key) => {
  for (const m of mode) if (m.startsWith(`${key}=`)) return Number(m.slice(key.length + 1));
  return undefined;
};
const stateDir = process.env.FAKE_PODMAN_STATE ?? join(here, ".fake-podman-state");

const log = (envNames = []) => {
  const file = process.env.FAKE_PODMAN_LOG;
  if (file !== undefined && file !== "") appendFileSync(file, `${JSON.stringify({ args, envNames })}\n`);
};

const live = () => {
  if (!existsSync(stateDir)) return [];
  return readdirSync(stateDir).map((name) => {
    try {
      return { name, ...JSON.parse(readFileSync(join(stateDir, name), "utf8")) };
    } catch {
      return { name, pid: 0, labels: [] };
    }
  });
};

const killGroup = (pid) => {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
};

const fail = (code, message) => {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(code);
};

const sub = args[0];
if (sub === "--version") {
  log();
  process.stdout.write(mode.has("old-version") ? "podman version 4.9.3\n" : "podman version 5.2.1\n");
  process.exit(0);
}
if (sub === "info") {
  log();
  process.stdout.write(JSON.stringify({ host: { security: { rootless: !mode.has("not-rootless") } } }));
  process.exit(0);
}
if (sub === "image" && args[1] === "exists") {
  log();
  process.exit(mode.has("no-image") ? 1 : 0);
}
if (sub === "ps") {
  log();
  const wanted = args.filter((a, i) => args[i - 1] === "--filter").map((f) => f.replace(/^label=/, ""));
  const names = live()
    .filter((c) => wanted.every((w) => (c.labels ?? []).includes(w)))
    .map((c) => c.name);
  process.stdout.write(names.length > 0 ? `${names.join("\n")}\n` : "");
  process.exit(0);
}
if (sub === "stop") {
  log();
  const name = args.at(-1);
  const c = live().find((x) => x.name === name);
  if (c === undefined) fail(125, `no container with name or ID "${name}" found: no such container`);
  killGroup(c.pid);
  process.exit(0);
}
if (sub === "rm") {
  log();
  if (mode.has("rm-fail")) fail(1, "rm failed: device or resource busy");
  const names = args.slice(1).filter((a) => !a.startsWith("-"));
  for (const name of names) {
    const c = live().find((x) => x.name === name);
    if (c !== undefined) killGroup(c.pid);
    rmSync(join(stateDir, name), { force: true });
  }
  process.exit(0);
}
if (sub !== "run") {
  log();
  fail(125, `unknown command ${sub}`);
}

// ---- run ----------------------------------------------------------------------------------------
let name;
let entrypoint;
const labels = [];
const envSpecs = [];
let i = 1;
for (; i < args.length; i++) {
  const a = args[i];
  if (a === "-e") {
    envSpecs.push(args[++i]);
    continue;
  }
  if (!a.startsWith("-")) break;
  if (a.startsWith("--name=")) name = a.slice("--name=".length);
  if (a.startsWith("--label=")) labels.push(a.slice("--label=".length));
  if (a.startsWith("--entrypoint=")) entrypoint = a.slice("--entrypoint=".length);
}
const command = args.slice(i + 1);
const env = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
for (const spec of envSpecs) {
  const eq = spec.indexOf("=");
  if (eq > 0) env[spec.slice(0, eq)] = spec.slice(eq + 1);
  else if (process.env[spec] !== undefined) env[spec] = process.env[spec];
}
log(Object.keys(env).sort());

if (entrypoint === "seance-probe") process.exit(modeValue("probe") ?? 0);
const runExit = modeValue("run-exit");
if (runExit !== undefined) fail(runExit, "crun: open `/home/runner/secret/path`: permission denied: OCI runtime error");

mkdirSync(stateDir, { recursive: true });
const stateFile = join(stateDir, name ?? `anon-${process.pid}`);
writeFileSync(stateFile, JSON.stringify({ pid: process.pid, labels }));
const cleanup = () => rmSync(stateFile, { force: true });

if (mode.has("slow-start")) {
  // Never answers: the harness's start budget must end it.
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
  setInterval(() => undefined, 1000);
} else {
  const child = spawn(join(here, "fake-kiro"), command, { env, stdio: "inherit" });
  const stop = () => {
    child.kill("SIGTERM");
  };
  process.on("SIGTERM", stop);
  child.on("exit", (code, signal) => {
    cleanup();
    process.exit(code ?? (signal === null ? 0 : 143));
  });
}
