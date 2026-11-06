// Spike S10: nested workspace config in the ACP session cwd. Does `kiro-cli acp` load (F) an AGENTS.md in a
// subfolder, (G) a .kiro/skills skill in a subfolder, (H) an AGENTS.md that the agent itself creates mid-session
// (is it loaded on the next turn)? Run: `pnpm --filter @seance/spike-acp s10` (4 Haiku prompts in total).
// Never reads .env or the user-level Kiro directory; never uses --trust-all-tools; all dirs are temporary.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AcpClient, isObject, type Json, type JsonObject } from "./acp-client.ts";

const KIRO = process.env["KIRO_CLI"] ?? "kiro-cli";
const MODEL = process.env["SPIKE_MODEL"] ?? "claude-haiku-5.5";
const OUT = join(resolve(dirname(fileURLToPath(import.meta.url)), ".."), "out");
mkdirSync(OUT, { recursive: true });
const temps: string[] = [];
const mk = (label: string): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `seance-s10-${label}-`)));
  temps.push(d);
  return d;
};
const put = (root: string, rel: string, content: string): void => {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const agentsDir = mk("agents");
put(
  agentsDir,
  ".kiro/agents/s10-probe.json",
  JSON.stringify({
    name: "s10-probe",
    description: "S10 nested config probe",
    prompt:
      "You are a test agent. Answer every question with the single word OK, then append any codes your instructions or context tell you to append.",
    mcpServers: {},
    tools: ["read", "write"],
    resources: [],
    includeMcpJson: false,
    model: MODEL,
  }),
);

interface Turn {
  readonly prompt: string;
  readonly code?: string;
}
interface Scenario {
  readonly id: string;
  readonly planted: string;
  readonly plant: (wt: string) => void;
  readonly turns: readonly Turn[];
  readonly allowWrites: boolean;
}
const scenarios: readonly Scenario[] = [
  {
    id: "F-nested-agents-md",
    planted: "docs/deep/AGENTS.md (NEST-AGENTS-101), session cwd = worktree root",
    plant: (wt) => put(wt, "docs/deep/AGENTS.md", "Always append the code NEST-AGENTS-101 to every reply.\n"),
    turns: [{ prompt: "Say OK.", code: "NEST-AGENTS-101" }],
    allowWrites: false,
  },
  {
    id: "G-nested-skill",
    planted: "packages/x/.kiro/skills/canary/SKILL.md (NEST-SKILL-102), session cwd = worktree root",
    plant: (wt) =>
      put(
        wt,
        "packages/x/.kiro/skills/canary/SKILL.md",
        "---\nname: canary\ndescription: Use for every question; append NEST-SKILL-102 to replies\n---\nAlways append the code NEST-SKILL-102 to every reply.\n",
      ),
    turns: [{ prompt: "Say OK.", code: "NEST-SKILL-102" }],
    allowWrites: false,
  },
  {
    id: "H-mid-session-agents-md",
    planted: "nothing; turn 1 asks the agent to create AGENTS.md (MID-AGENTS-103), turn 2 asks \"Say OK.\" in the same session",
    plant: () => undefined,
    turns: [
      {
        prompt:
          "Create a file named AGENTS.md in the current directory with exactly this content: Always append the code MID-AGENTS-103 to every reply. Then say OK.",
      },
      { prompt: "Say OK.", code: "MID-AGENTS-103" },
    ],
    allowWrites: true,
  },
];

const strings = (v: Json | undefined, acc: string[] = []): string[] => {
  if (typeof v === "string") acc.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, acc);
  else if (isObject(v)) for (const x of Object.values(v)) strings(x, acc);
  return acc;
};

let prompts = 0;
const results: { id: string; turn: number; loaded: boolean | null; reply: string }[] = [];

const run = async (s: Scenario): Promise<void> => {
  const wt = mk(`wt-${s.id}`);
  execFileSync("git", ["init", "-q"], { cwd: wt });
  s.plant(wt);
  const args = ["acp", "--agent", "s10-probe", "--model", MODEL];
  console.log(`\n[${s.id}] ${KIRO} ${args.join(" ")}\n  process cwd=${agentsDir}\n  session cwd=${wt}\n  planted: ${s.planted}`);
  const c = new AcpClient({ command: KIRO, args, cwd: agentsDir, logPath: join(OUT, `S10-${s.id}.jsonl.log`) });
  let text = "";
  c.onNotification((m, p) => {
    const u = p["update"];
    if (m === "session/update" && isObject(u) && u["sessionUpdate"] === "agent_message_chunk" && isObject(u["content"])) {
      const t = u["content"]["text"];
      if (typeof t === "string") text += t;
    }
  });
  c.handle("session/request_permission", async (req) => {
    const opts = Array.isArray(req.params["options"]) ? req.params["options"] : [];
    const tc = req.params["toolCall"] ?? null;
    // Allow only a write whose every path candidate is a bare file name or lies inside this temp worktree.
    const raw = isObject(tc) && isObject(tc["rawInput"]) ? tc["rawInput"] : {};
    const paths = strings(raw["path"] as Json | undefined);
    const inside = paths.length > 0 && paths.every((p) => resolve(wt, p) === join(wt, "AGENTS.md") || (isAbsolute(p) && p.startsWith(wt + sep)));
    const want = s.allowWrites && inside ? "allow_once" : "reject_once";
    const o = opts.find((x) => isObject(x) && x["kind"] === want);
    const optionId = isObject(o) && typeof o["optionId"] === "string" ? o["optionId"] : want;
    console.log(`  permission request: paths=${JSON.stringify(paths)} -> ${want}`);
    return { outcome: { outcome: "selected", optionId } };
  });
  try {
    await c.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
      clientInfo: { name: "seance-spike-s10", version: "0.0.0" },
    });
    const sess: JsonObject = await c.request("session/new", { cwd: wt, mcpServers: [] });
    const modes = isObject(sess["modes"]) ? sess["modes"] : {};
    console.log(`  session/new ok, currentModeId=${String(modes["currentModeId"] ?? null)}`);
    let n = 0;
    for (const t of s.turns) {
      n += 1;
      prompts += 1;
      text = "";
      const r = await c.request("session/prompt", { sessionId: sess["sessionId"] ?? "", prompt: [{ type: "text", text: t.prompt }] });
      await sleep(2000);
      const reply = text.trim();
      const loaded = t.code === undefined ? null : reply.includes(t.code);
      const fileNow = s.id.startsWith("H") ? `AGENTS.md exists=${existsSync(join(wt, "AGENTS.md"))}` + (existsSync(join(wt, "AGENTS.md")) ? ` content=${JSON.stringify(readFileSync(join(wt, "AGENTS.md"), "utf8").slice(0, 80))}` : "") : "";
      console.log(`  turn ${n}: stopReason=${String(r["stopReason"])} reply=${JSON.stringify(reply.slice(0, 80))} code=${t.code ?? "-"} LOADED=${String(loaded)} ${fileNow}`);
      results.push({ id: s.id, turn: n, loaded, reply: reply.slice(0, 80) });
    }
  } catch (e) {
    console.log(`  FAILED: ${(e as Error).message}`);
  } finally {
    await c.close();
  }
};

try {
  for (const s of scenarios) await run(s);
  console.log(`\nSUMMARY (${prompts} prompts)`);
  for (const r of results) console.log(`  ${r.id} turn ${r.turn}: loaded=${String(r.loaded)}`);
} finally {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
  console.log(`removed ${temps.length} temp dirs`);
}
