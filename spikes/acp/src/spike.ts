// Spike: can Node.js drive `kiro-cli acp` well enough for Séance? Run: `pnpm --filter @seance/spike-acp spike`
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AcpClient, isObject, type IncomingRequest, type Json, type JsonObject } from "./acp-client.ts";

const KIRO = process.env["KIRO_CLI"] ?? "kiro-cli";
const MODEL = process.env["SPIKE_MODEL"] ?? "claude-haiku-5.5";
const PROMPT_TIMEOUT_MS = 180_000;
const SPIKE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(SPIKE_DIR, "out");
mkdirSync(OUT, { recursive: true });

const tempDirs: string[] = [];
let promptsSent = 0;
let credits = 0;
// SPIKE_ONLY=S5 runs S1+S2+S5 only (to re-run one scenario without spending the full prompt budget).
const ONLY = process.env["SPIKE_ONLY"];
const runs = (s: string): boolean => ONLY === undefined || ONLY === s;

interface Result {
  readonly scenario: string;
  readonly ok: boolean;
  readonly metrics: Readonly<Record<string, Json>>;
  readonly notes: readonly string[];
}
const results: Result[] = [];
const record = (r: Result): void => {
  results.push(r);
  console.log(`[${r.ok ? "OK " : "FAIL"}] ${r.scenario} ${JSON.stringify(r.metrics)}${r.notes.length ? `\n       ${r.notes.join("\n       ")}` : ""}`);
};

const ms = (from: number): number => Math.round(performance.now() - from);
const sleep = (t: number): Promise<void> => new Promise((r) => setTimeout(r, t));

const makeWorkdir = (label: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `seance-acp-${label}-`)));
  tempDirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
};

// ---- per-client state: session cwd + permission policy ------------------------------------
type Policy = "allow" | "reject";
interface Harness {
  readonly client: AcpClient;
  readonly sessionCwd: Map<string, string>;
  readonly policy: Map<string, Policy>;
  readonly permissionLog: { sessionId: string; title: string; kinds: string[]; answered: string }[];
  readonly fsLog: { method: string; path: string; allowed: boolean }[];
}

const insideCwd = (cwd: string, p: string): boolean => {
  const abs = resolve(cwd, p);
  return abs === cwd || abs.startsWith(cwd + sep);
};

const str = (v: Json | undefined): string => (typeof v === "string" ? v : "");

const harnesses: Harness[] = [];

const startHarness = (label: string, args: readonly string[], cwd: string): Harness => {
  const client = new AcpClient({ command: KIRO, args: ["acp", ...args], cwd, logPath: join(OUT, `${ONLY === undefined ? "" : `${ONLY}-`}${label}.jsonl.log`) });
  const h: Harness = { client, sessionCwd: new Map(), policy: new Map(), permissionLog: [], fsLog: [] };
  harnesses.push(h);

  client.handle("session/request_permission", async (req: IncomingRequest) => {
    const sessionId = str(req.params["sessionId"]);
    const toolCall = isObject(req.params["toolCall"]) ? req.params["toolCall"] : {};
    const options = Array.isArray(req.params["options"]) ? (req.params["options"] as readonly Json[]).filter(isObject) : [];
    const kinds = options.map((o) => str(o["kind"]));
    const want = (h.policy.get(sessionId) ?? "reject") === "allow" ? "allow_once" : "reject_once";
    const chosen = options.find((o) => o["kind"] === want) ?? options.find((o) => str(o["kind"]).startsWith(want.split("_")[0] ?? ""));
    const answered = chosen === undefined ? "cancelled" : str(chosen["optionId"]);
    h.permissionLog.push({ sessionId, title: str(toolCall["title"]), kinds, answered });
    return chosen === undefined
      ? { outcome: { outcome: "cancelled" } }
      : { outcome: { outcome: "selected", optionId: str(chosen["optionId"]) } };
  });

  client.handle("fs/read_text_file", async (req) => {
    const cwd = h.sessionCwd.get(str(req.params["sessionId"])) ?? "";
    const p = str(req.params["path"]);
    const allowed = cwd !== "" && insideCwd(cwd, p);
    h.fsLog.push({ method: "fs/read_text_file", path: p, allowed });
    if (!allowed) throw new Error(`read denied: ${p} is outside the session cwd`);
    return { content: readFileSync(resolve(cwd, p), "utf8") };
  });

  client.handle("fs/write_text_file", async (req) => {
    const cwd = h.sessionCwd.get(str(req.params["sessionId"])) ?? "";
    const p = str(req.params["path"]);
    const allowed = cwd !== "" && insideCwd(cwd, p);
    h.fsLog.push({ method: "fs/write_text_file", path: p, allowed });
    if (!allowed) throw new Error(`write denied: ${p} is outside the session cwd`);
    writeFileSync(resolve(cwd, p), str(req.params["content"]));
    return null;
  });

  return h;
};

const initialize = (h: Harness): Promise<JsonObject> =>
  h.client.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    clientInfo: { name: "seance-spike", version: "0.0.0" },
  });

const newSession = async (h: Harness, cwd: string): Promise<{ sessionId: string; result: JsonObject; ms: number }> => {
  const t = performance.now();
  const result = await h.client.request("session/new", { cwd, mcpServers: [] });
  const sessionId = str(result["sessionId"]);
  if (sessionId === "") throw new Error("session/new returned no sessionId");
  h.sessionCwd.set(sessionId, cwd);
  return { sessionId, result, ms: ms(t) };
};

interface PromptRun {
  readonly text: string;
  readonly firstChunkMs: number | null;
  readonly totalMs: number;
  readonly stopReason: string;
  readonly updateKinds: Readonly<Record<string, number>>;
  readonly meta: Json | undefined;
}

const prompt = async (
  h: Harness,
  sessionId: string,
  text: string,
  onFirstChunk?: (t0: number) => void,
): Promise<PromptRun> => {
  promptsSent++;
  if (promptsSent > 15) throw new Error("prompt budget (15) exceeded");
  const t0 = performance.now();
  let firstChunkMs: number | null = null;
  let out = "";
  const kinds: Record<string, number> = {};
  const off = h.client.onNotification((method, params) => {
    if (method !== "session/update" || params["sessionId"] !== sessionId) return;
    const update = isObject(params["update"]) ? params["update"] : {};
    const kind = str(update["sessionUpdate"]);
    kinds[kind] = (kinds[kind] ?? 0) + 1;
    const content = isObject(update["content"]) ? update["content"] : {};
    const isChunk = kind === "agent_message_chunk" || kind === "agent_thought_chunk";
    if (isChunk && firstChunkMs === null) {
      firstChunkMs = ms(t0);
      onFirstChunk?.(t0);
    }
    if (kind === "agent_message_chunk" && typeof content["text"] === "string") out += content["text"];
  });
  const offMeter = h.client.onNotification((method, params) => {
    if (method !== "_kiro.dev/metadata" || params["sessionId"] !== sessionId || !Array.isArray(params["meteringUsage"])) return;
    for (const m of params["meteringUsage"] as readonly Json[]) {
      if (isObject(m) && typeof m["value"] === "number") credits += m["value"];
    }
  });
  try {
    const result = await Promise.race([
      h.client.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }),
      sleep(PROMPT_TIMEOUT_MS).then(() => {
        throw new Error(`session/prompt timed out after ${PROMPT_TIMEOUT_MS}ms`);
      }),
    ]);
    return { text: out, firstChunkMs, totalMs: ms(t0), stopReason: str(result["stopReason"]), updateKinds: kinds, meta: result["_meta"] };
  } finally {
    off();
    offMeter();
  }
};

const descendants = (pid: number): number[] => {
  let kids: number[] = [];
  try {
    kids = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number);
  } catch {
    kids = []; // pgrep exits 1 when there are no children
  }
  return kids.flatMap((k) => [k, ...descendants(k)]);
};
const alive = (pid: number): string | null => {
  try {
    return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------------------------
const main = async (): Promise<void> => {
  const pongPrompt = "Reply with exactly: pong";

  // S1 — spawn + initialize (no --agent)
  const w1 = makeWorkdir("s1");
  let t = performance.now();
  const h = startHarness("main", ["--model", MODEL], w1);
  const init = await initialize(h);
  const initMs = ms(t);
  record({
    scenario: "S1 spawn+initialize (no --agent)",
    ok: isObject(init["agentCapabilities"]),
    metrics: { spawnToInitMs: initMs, protocolVersion: init["protocolVersion"] ?? null, agentCapabilities: init["agentCapabilities"] ?? null, authMethods: init["authMethods"] ?? null },
    notes: [],
  });

  // S2 — session/new in a git-initialised temp dir
  const s2 = await newSession(h, w1);
  const modes = isObject(s2.result["modes"]) ? s2.result["modes"] : {};
  const models = isObject(s2.result["models"]) ? s2.result["models"] : {};
  record({
    scenario: "S2 session/new",
    ok: true,
    metrics: { ms: s2.ms, sessionId: s2.sessionId, currentModeId: modes["currentModeId"] ?? null, currentModelId: models["currentModelId"] ?? null },
    notes: [],
  });

  // S3 — short prompt
  if (runs("S3")) {
  const p3 = await prompt(h, s2.sessionId, pongPrompt);
  record({
    scenario: "S3 prompt pong",
    ok: p3.text.trim().toLowerCase().includes("pong") && p3.stopReason === "end_turn",
    metrics: { firstChunkMs: p3.firstChunkMs, totalMs: p3.totalMs, stopReason: p3.stopReason, reply: p3.text.trim().slice(0, 80), updateKinds: p3.updateKinds, meta: p3.meta ?? null },
    notes: [],
  });
  }

  // S4 — two parallel sessions in one process (= two channels)
  if (runs("S4")) {
  const [a, b] = await Promise.all([newSession(h, makeWorkdir("s4a")), newSession(h, makeWorkdir("s4b"))]);
  t = performance.now();
  const [a1, b1] = await Promise.all([
    prompt(h, a.sessionId, "Remember the codeword ALPHA-7 for later. Reply with exactly: ok"),
    prompt(h, b.sessionId, "Remember the codeword BRAVO-9 for later. Reply with exactly: ok"),
  ]);
  const setMs = ms(t);
  t = performance.now();
  const [a2, b2] = await Promise.all([
    prompt(h, a.sessionId, "What codeword did I ask you to remember? Reply with only the codeword(s) you know."),
    prompt(h, b.sessionId, "What codeword did I ask you to remember? Reply with only the codeword(s) you know."),
  ]);
  const askMs = ms(t);
  const isolated = a2.text.includes("ALPHA-7") && !a2.text.includes("BRAVO") && b2.text.includes("BRAVO-9") && !b2.text.includes("ALPHA");
  record({
    scenario: "S4 two parallel sessions",
    ok: isolated && a1.stopReason === "end_turn" && b1.stopReason === "end_turn",
    metrics: {
      parallelSetMs: setMs,
      parallelAskMs: askMs,
      perPromptMs: [a1.totalMs, b1.totalMs, a2.totalMs, b2.totalMs],
      aReply: a2.text.trim().slice(0, 60),
      bReply: b2.text.trim().slice(0, 60),
      isolated,
    },
    notes: [],
  });
  }

  // S5 — cancel mid-stream, then reuse the same session.
  // Haiku emits 300 short numbers in <1s, so the prompt asks for longer output; the cancel timer is
  // cleared if the turn ends first (a late cancel would otherwise abort the *next* prompt — observed in run 1).
  if (runs("S5")) {
  let cancelSentAt = 0;
  let cancelTimer: NodeJS.Timeout | undefined;
  const p5 = await prompt(h, s2.sessionId, "Write the numbers from 1 to 1000 spelled out as English words, one per line. Output only the words.", () => {
    cancelTimer = setTimeout(() => {
      cancelSentAt = performance.now();
      h.client.notify("session/cancel", { sessionId: s2.sessionId });
    }, 1000);
  });
  clearTimeout(cancelTimer);
  const cancelLatency = cancelSentAt === 0 ? null : Math.round(performance.now() - cancelSentAt);
  const lastNumber = p5.text.trim().split("\n").at(-1) ?? "";
  // Run 2 showed a follow-up sent 0ms after the cancelled turn resolved is itself answered "cancelled"
  // within 2ms (Kiro is still tearing the turn down). Settle delay before reusing the session:
  await sleep(Number(process.env["SPIKE_CANCEL_SETTLE_MS"] ?? "1000"));
  const p5b = await prompt(h, s2.sessionId, pongPrompt);
  record({
    scenario: "S5 session/cancel",
    ok: p5.stopReason === "cancelled" && p5b.stopReason === "end_turn" && p5b.text.toLowerCase().includes("pong"),
    metrics: {
      firstChunkMs: p5.firstChunkMs,
      cancelToResolveMs: cancelLatency,
      stopReason: p5.stopReason,
      lastNumberStreamed: lastNumber,
      followUpStopReason: p5b.stopReason,
      followUpReply: p5b.text.trim().slice(0, 40),
      followUpMs: p5b.totalMs,
    },
    notes: [],
  });
  }

  // S6 — tool permission: allow once, reject once
  if (runs("S6"))
  for (const policy of ["allow", "reject"] as const) {
    const dir = makeWorkdir(`s6-${policy}`);
    const s = await newSession(h, dir);
    h.policy.set(s.sessionId, policy);
    const permBefore = h.permissionLog.length;
    const fsBefore = h.fsLog.length;
    const r = await prompt(h, s.sessionId, "Create a file named hello.txt in the current working directory containing exactly the text: hi. Then reply with exactly: done");
    const created = existsSync(join(dir, "hello.txt"));
    const escaped = existsSync(join(SPIKE_DIR, "hello.txt")) || existsSync(join(w1, "hello.txt"));
    const perms = h.permissionLog.slice(permBefore);
    const fsCalls = h.fsLog.slice(fsBefore);
    record({
      scenario: `S6 permission ${policy}`,
      ok: (policy === "allow" ? created : !created) && !escaped,
      metrics: {
        totalMs: r.totalMs,
        stopReason: r.stopReason,
        fileCreated: created,
        content: created ? readFileSync(join(dir, "hello.txt"), "utf8").slice(0, 20) : null,
        escapedCwd: escaped,
        permissionRequests: perms.map((p) => ({ title: p.title, kinds: p.kinds, answered: p.answered })),
        fsCalls,
        updateKinds: r.updateKinds,
      },
      notes: [`reply: ${r.text.trim().slice(0, 120)}`],
    });
  }

  // S1b — custom agent via --agent spike (process cwd holds .kiro/agents/spike.json)
  if (runs("S1b")) {
  const hb = startHarness("agent-spike", ["--agent", "spike", "--model", MODEL], SPIKE_DIR);
  t = performance.now();
  await initialize(hb);
  const initB = ms(t);
  const sb = await newSession(hb, makeWorkdir("s1b"));
  const modesB = isObject(sb.result["modes"]) ? sb.result["modes"] : {};
  const pb = await prompt(hb, sb.sessionId, pongPrompt);
  record({
    scenario: "S1b --agent spike (local .kiro/agents)",
    ok: modesB["currentModeId"] === "spike" && pb.text.toLowerCase().includes("pong"),
    metrics: { spawnToInitMs: initB, sessionNewMs: sb.ms, currentModeId: modesB["currentModeId"] ?? null, promptMs: pb.totalMs },
    notes: [],
  });
  await hb.client.close();
  }

  // S7 — SIGTERM in the middle of a prompt
  if (runs("S7")) {
  const hk = startHarness("kill", ["--model", MODEL], SPIKE_DIR);
  await initialize(hk);
  const sk = await newSession(hk, makeWorkdir("s7"));
  const rootPid = hk.client.pid ?? -1;
  let tree: number[] = [];
  let killAt = 0;
  const promptOutcome = await prompt(hk, sk.sessionId, "Count from 1 to 300, one number per line. Output only the numbers.", () => {
    tree = descendants(rootPid);
    killAt = performance.now();
    hk.client.proc.kill("SIGTERM");
  }).then(
    (r) => `resolved stopReason=${r.stopReason}`,
    (e: Error) => `rejected: ${e.message}`,
  );
  const exit = await hk.client.exited;
  const exitMs = Math.round(performance.now() - killAt);
  await sleep(1500);
  const leftovers = [rootPid, ...tree].map((pid) => ({ pid, stat: alive(pid) })).filter((p) => p.stat !== null);
  record({
    scenario: "S7 SIGTERM mid-prompt",
    ok: leftovers.length === 0,
    metrics: { killToExitMs: exitMs, exitCode: exit.code, signal: exit.signal, childPidsBeforeKill: tree.length, leftovers, promptOutcome },
    notes: [],
  });
  await hk.client.close();
  }

  await h.client.close();
  const counts = { notifications: Object.fromEntries(h.client.notificationCounts), agentRequests: Object.fromEntries(h.client.requestCounts) };
  record({ scenario: "observed methods (main process)", ok: true, metrics: counts, notes: [] });
};

try {
  await main();
} catch (err) {
  record({ scenario: "fatal", ok: false, metrics: {}, notes: [(err as Error).stack ?? String(err)] });
  process.exitCode = 1;
} finally {
  await Promise.all(harnesses.map((x) => x.client.close().catch(() => undefined)));
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  writeFileSync(join(OUT, `results${ONLY === undefined ? "" : `-${ONLY}`}.json`), `${JSON.stringify({ model: MODEL, promptsSent, results }, null, 2)}\n`);
  console.log(`prompts sent: ${promptsSent}; credits metered: ${credits.toFixed(4)}; temp dirs removed: ${tempDirs.length}`);
}
