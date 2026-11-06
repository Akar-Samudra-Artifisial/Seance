// Spike S8: where does `kiro-cli acp --agent <name>` look for the agent file when the process cwd differs from the
// session cwd? Run: `pnpm --filter @seance/spike-acp s8` (spends a handful of tiny prompts; never reads .env).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AcpClient, isObject, type JsonObject } from "./acp-client.ts";

const KIRO = process.env["KIRO_CLI"] ?? "kiro-cli";
const MODEL = process.env["SPIKE_MODEL"] ?? "claude-haiku-5.5";
const OUT = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "out");
mkdirSync(OUT, { recursive: true });
const temps: string[] = [];

const mk = (label: string): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `seance-s8-${label}-`)));
  temps.push(d);
  return d;
};
const writeAgent = (root: string, name: string, code: string): void => {
  const dir = join(root, ".kiro", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.json`),
    JSON.stringify({
      name,
      description: "S8 agent-resolution probe",
      prompt: `You are a test agent. Your secret code is ${code}. When asked for the code, reply with exactly the code and nothing else.`,
      mcpServers: {},
      tools: ["read"],
      allowedTools: [],
      resources: [],
      includeMcpJson: false,
      model: MODEL,
    }),
  );
};

const scenario = async (label: string, processCwd: string, sessionCwd: string, agent: string, code: string): Promise<void> => {
  const args = ["acp", "--agent", agent, "--model", MODEL];
  console.log(`\n[${label}] ${KIRO} ${args.join(" ")}  (process cwd=${processCwd}, session cwd=${sessionCwd})`);
  const c = new AcpClient({ command: KIRO, args, cwd: processCwd, logPath: join(OUT, `S8-${label}.jsonl.log`) });
  let text = "";
  c.onNotification((m, p) => {
    const u = p["update"];
    if (m === "session/update" && isObject(u) && u["sessionUpdate"] === "agent_message_chunk" && isObject(u["content"])) {
      const t = u["content"]["text"];
      if (typeof t === "string") text += t;
    }
  });
  try {
    await c.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      clientInfo: { name: "seance-spike-s8", version: "0.0.0" },
    });
    console.log(`[${label}] initialize: ok`);
    const s: JsonObject = await c.request("session/new", { cwd: sessionCwd, mcpServers: [] });
    const modes = isObject(s["modes"]) ? s["modes"] : {};
    console.log(`[${label}] session/new: ok, currentModeId=${String(modes["currentModeId"] ?? null)}`);
    const r = await c.request("session/prompt", { sessionId: s["sessionId"] ?? "", prompt: [{ type: "text", text: "What is the code?" }] });
    console.log(`[${label}] prompt: stopReason=${String(r["stopReason"])} reply=${JSON.stringify(text.trim().slice(0, 80))} codeSeen=${text.includes(code)}`);
  } catch (e) {
    console.log(`[${label}] FAILED: ${(e as Error).message}`);
  } finally {
    const exit = await Promise.race([c.exited, new Promise<null>((r) => setTimeout(() => r(null), 100))]);
    console.log(`[${label}] process exited early: ${exit === null ? "no" : JSON.stringify(exit)}`);
    await c.close();
  }
};

try {
  // A: agent file in the process cwd only; session cwd is a different directory without any agent file.
  const agentsDir = mk("agents");
  const wtA = mk("worktree-a");
  writeAgent(agentsDir, "s8-proc", "CODE-PROC-81");
  await scenario("A-process-cwd", agentsDir, wtA, "s8-proc", "CODE-PROC-81");

  // B: agent file in the session cwd only; the process cwd has none.
  const emptyProc = mk("empty-proc");
  const wtB = mk("worktree-b");
  writeAgent(wtB, "s8-sess", "CODE-SESS-82");
  await scenario("B-session-cwd", emptyProc, wtB, "s8-sess", "CODE-SESS-82");
} finally {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
  console.log(`\nremoved ${temps.length} temp dirs`);
}
