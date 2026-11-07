import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AcpClient, type JsonObject } from "../src/acp/client.js";
import type { LogFields, RunnerLogger } from "../src/log.js";
import { ManualClock } from "./fixtures/manual-clock.js";

const FAKE_KIRO = fileURLToPath(new URL("./fixtures/fake-kiro", import.meta.url));

interface LogEntry {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly msg: string;
  readonly fields: LogFields | undefined;
}

const memoryLogger = (): { readonly logger: RunnerLogger; readonly entries: LogEntry[] } => {
  const entries: LogEntry[] = [];
  const at =
    (level: LogEntry["level"]) =>
    (msg: string, fields?: LogFields): void => {
      entries.push({ level, msg, fields });
    };
  return {
    entries,
    logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") },
  };
};

const open: AcpClient[] = [];

const makeClient = (
  script: object | undefined,
  command = FAKE_KIRO,
): { readonly client: AcpClient; readonly entries: LogEntry[] } => {
  const { logger, entries } = memoryLogger();
  const env: Record<string, string | undefined> = { ...process.env };
  if (script !== undefined) env["FAKE_AGENT_SCRIPT"] = JSON.stringify(script);
  const client = new AcpClient({
    command,
    args: ["acp", "--agent", "fake"],
    cwd: tmpdir(),
    env,
    logger,
    clock: new ManualClock(),
  });
  open.push(client);
  return { client, entries };
};

const errors = (entries: readonly LogEntry[]): LogEntry[] => entries.filter((e) => e.level === "error");

const newSession = async (client: AcpClient): Promise<string> => {
  await client.request("initialize", { protocolVersion: 1 });
  const res = await client.request("session/new", { cwd: tmpdir(), mcpServers: [] });
  return res["sessionId"] as string;
};

const prompt = (client: AcpClient, sessionId: string): Promise<JsonObject> =>
  client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "hi" }] });

const permissionAnswers = async (
  client: AcpClient,
): Promise<readonly { readonly id: number | string; readonly optionId: string | null }[]> => {
  const dump = await client.request("fake/dump", {});
  return dump["permissionAnswers"] as never;
};

afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
});

describe("AcpClient against the Fake_Agent", () => {
  it("rejects a request when the command cannot be spawned", async () => {
    const { client } = makeClient(undefined, "/nonexistent/seance-no-such-kiro");
    await expect(client.request("initialize", {})).rejects.toThrow(/failed: spawn error, last stderr: /);
    expect(client.running).toBe(false);
  });

  it("rejects pending requests with exit code and last stderr line on early exit", async () => {
    const { client } = makeClient({ turns: "not-an-array" });
    const p = client.request("initialize", {});
    await expect(p).rejects.toThrow(/failed: exit code 2, last stderr: fake-agent: invalid FAKE_AGENT_SCRIPT/);
    expect(client.lastStderrLine).toContain("invalid FAKE_AGENT_SCRIPT");
  });

  it("echoes a string request id unchanged", async () => {
    const { client } = makeClient({
      turns: [{ steps: [{ permission: { toolCall: { kind: "edit", title: "w", path: "a.txt" } } }] }],
    });
    client.handle("session/request_permission", async (req) => {
      expect(typeof req.id).toBe("string");
      return { outcome: { outcome: "selected", optionId: "allow_once" } };
    });
    const sessionId = await newSession(client);
    await expect(prompt(client, sessionId)).resolves.toEqual({ stopReason: "end_turn" });
    const answers = await permissionAnswers(client);
    expect(answers).toHaveLength(1);
    expect(typeof answers[0]?.id).toBe("string");
    expect(answers[0]?.optionId).toBe("allow_once");
  });

  it("echoes a numeric request id unchanged", async () => {
    const { client } = makeClient({
      turns: [{ steps: [{ permission: { toolCall: { kind: "edit", title: "w", path: "a.txt" }, ids: "number" } }] }],
    });
    let seen: number | string | undefined;
    client.handle("session/request_permission", async (req) => {
      seen = req.id;
      return { outcome: { outcome: "selected", optionId: "reject_once" } };
    });
    const sessionId = await newSession(client);
    await expect(prompt(client, sessionId)).resolves.toEqual({ stopReason: "end_turn" });
    expect(typeof seen).toBe("number");
    const answers = await permissionAnswers(client);
    expect(answers).toEqual([{ id: seen, optionId: "reject_once" }]);
  });

  it("logs one error for an invalid frame and keeps the process and requests working", async () => {
    const { client, entries } = makeClient(undefined);
    await newSession(client);
    const pid = client.pid;
    // The Fake_Agent answers a non-JSON line with an id-less error, which is an invalid frame.
    const internals = client as unknown as { proc: { child: { stdin: { write(s: string): boolean } } } };
    internals.proc.child.stdin.write("this is not json\n");
    const dump = await client.request("fake/dump", {});
    expect(dump["requests"]).toContain("session/new");
    expect(client.running).toBe(true);
    expect(client.pid).toBe(pid);
    const errs = errors(entries);
    expect(errs).toHaveLength(1);
    expect(errs[0]?.msg).toBe("acp frame discarded");
  });

  it("ignores unknown _kiro.dev/* notifications without an error log", async () => {
    const { client, entries } = makeClient({
      turns: [{ steps: [{ metadata: { turnDurationMs: 5 } }, { chunk: "x" }] }],
    });
    const seen: string[] = [];
    client.onNotification((method) => seen.push(method));
    const sessionId = await newSession(client);
    await expect(prompt(client, sessionId)).resolves.toEqual({ stopReason: "end_turn" });
    expect(seen).toContain("_kiro.dev/metadata");
    expect(client.notificationCounts.get("_kiro.dev/metadata")).toBe(1);
    expect(errors(entries)).toEqual([]);
    expect(entries.filter((e) => e.level === "warn")).toEqual([]);
  });

  it("spawns a new process for the next request after the first one exits", async () => {
    const { client } = makeClient(undefined);
    await client.request("initialize", {});
    const first = client.pid;
    expect(first).toBeDefined();
    await client.kill("SIGTERM");
    expect(client.running).toBe(false);
    await client.request("initialize", {});
    expect(client.running).toBe(true);
    expect(client.pid).toBeDefined();
    expect(client.pid).not.toBe(first);
  });
});
