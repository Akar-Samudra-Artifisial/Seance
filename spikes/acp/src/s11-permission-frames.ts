// Spike S11: what does kiro-cli 3.1 put in `session/update` tool_call / tool_call_update and in
// `session/request_permission` for (A) an edit of an existing file and (B) a shell `ls`, when the session cwd
// sits under a symlinked directory (macOS: /tmp -> /private/tmp, /var -> /private/var)?
// Run: `pnpm --filter @seance/spike-acp s11` (2 Haiku prompts, one process, one session).
// Writes the normalised frames to apps/runner/test/fixtures/kiro-3.1-permission-frames.jsonl.
// Never reads .env or the user-level Kiro directory; never uses --trust-all-tools; all dirs are temporary.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AcpClient, isObject, redact, type JsonObject } from "./acp-client.ts";

const KIRO = process.env["KIRO_CLI"] ?? "kiro-cli";
const MODEL = process.env["SPIKE_MODEL"] ?? "claude-haiku-5.5";
const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(HERE, "out");
const FIXTURE = resolve(HERE, "../../apps/runner/test/fixtures/kiro-3.1-permission-frames.jsonl");
mkdirSync(OUT, { recursive: true });

/** A parent directory that is itself a symlink (so the unresolved and the real path differ). */
const linkedParent = (): string => {
  for (const candidate of ["/tmp", tmpdir()]) {
    try {
      if (lstatSync(candidate).isSymbolicLink() || realpathSync(candidate) !== candidate) return candidate;
    } catch {
      // try the next one
    }
  }
  return tmpdir();
};

const temps: string[] = [];
const agentsDir = realpathSync(mkdtempSync(join(tmpdir(), "seance-s11-agents-")));
temps.push(agentsDir);
const parent = linkedParent();
const wtLink = mkdtempSync(join(parent, "seance-s11-wt-")); // NOT realpath'ed on purpose
const wtReal = realpathSync(wtLink);
temps.push(wtReal);

const put = (root: string, rel: string, content: string): void => {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
};

put(
  agentsDir,
  ".kiro/agents/s11-probe.json",
  JSON.stringify({
    name: "s11-probe",
    description: "S11 permission frame probe",
    prompt: "You are a test agent. Do exactly what you are asked with the fewest tool calls, then reply DONE.",
    mcpServers: {},
    tools: ["read", "write", "shell"],
    allowedTools: [],
    resources: [],
    includeMcpJson: false,
    model: MODEL,
  }),
);

execFileSync("git", ["init", "-q"], { cwd: wtReal });
put(wtReal, "login.js", "function login(user) {\n  return check(user); // bug\n}\n");

const logPath = join(OUT, "S11-permission-frames.jsonl.log");
const frames: string[] = [];
const c = new AcpClient({ command: KIRO, args: ["acp", "--agent", "s11-probe", "--model", MODEL], cwd: agentsDir, logPath });

const keep = (method: string, params: JsonObject): boolean => {
  if (method === "session/request_permission") return true;
  const u = params["update"];
  return method === "session/update" && isObject(u) && (u["sessionUpdate"] === "tool_call" || u["sessionUpdate"] === "tool_call_update");
};
const record = (frame: JsonObject): void => {
  frames.push(JSON.stringify(frame));
};

c.onNotification((method, params) => {
  if (keep(method, params)) record({ jsonrpc: "2.0", method, params });
});
c.handle("session/request_permission", async (req) => {
  record({ jsonrpc: "2.0", id: req.id, method: "session/request_permission", params: req.params });
  const opts = Array.isArray(req.params["options"]) ? req.params["options"] : [];
  const o = opts.find((x) => isObject(x) && x["kind"] === "allow_once");
  const optionId = isObject(o) && typeof o["optionId"] === "string" ? o["optionId"] : "allow_once";
  console.log(`  permission request ${JSON.stringify(req.params["toolCall"]).slice(0, 300)} -> allow_once (temp worktree)`);
  return { outcome: { outcome: "selected", optionId } };
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const prompts = [
  "In login.js, replace the text `// bug` with `// fixed`. Edit the existing file; do not create new files.",
  "Run the shell command `ls` in the current directory and tell me the output.",
];

/** Longest first, so the real path is replaced before its symlinked prefix could match inside it. */
const normalise = (line: string): string => {
  const subs: readonly (readonly [string, string])[] = [
    [wtReal, "__WT__"],
    [wtLink, "__WT_LINK__"],
    [agentsDir, "__AGENTS__"],
  ];
  return [...subs]
    .sort((a, b) => b[0].length - a[0].length)
    .reduce((acc, [from, to]) => acc.split(from).join(to), redact(line));
};

try {
  console.log(`[S11] ${KIRO} acp --agent s11-probe --model ${MODEL}\n  process cwd=${agentsDir}\n  session cwd=${wtLink} (real ${wtReal})`);
  const init = await c.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "seance-spike-s11", version: "0.0.0" },
  });
  console.log(`  agentInfo=${JSON.stringify(init["agentInfo"] ?? null)}`);
  const sess: JsonObject = await c.request("session/new", { cwd: wtLink, mcpServers: [] });
  const modes = isObject(sess["modes"]) ? sess["modes"] : {};
  console.log(`  session/new ok, currentModeId=${String(modes["currentModeId"] ?? null)}`);
  for (const text of prompts) {
    const r = await c.request("session/prompt", { sessionId: sess["sessionId"] ?? "", prompt: [{ type: "text", text }] });
    await sleep(1500);
    console.log(`  prompt done: stopReason=${String(r["stopReason"])}`);
  }
  console.log(`  login.js now: ${JSON.stringify(existsSync(join(wtReal, "login.js")) ? readFileSync(join(wtReal, "login.js"), "utf8") : null)}`);
} catch (e) {
  console.log(`  FAILED: ${(e as Error).message}`);
} finally {
  await c.close();
  writeFileSync(FIXTURE, frames.map(normalise).join("\n") + (frames.length > 0 ? "\n" : ""));
  console.log(`wrote ${frames.length} frames to ${FIXTURE}`);
  for (const d of temps) rmSync(d, { recursive: true, force: true });
  console.log(`removed ${temps.length} temp dirs (2 prompts)`);
}
