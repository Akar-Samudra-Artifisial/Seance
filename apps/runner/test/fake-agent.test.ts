import { describe, expect, it } from "vitest";
import { FakeAgentCore } from "./fixtures/fake-agent.js";
import type { FakeScript } from "./fixtures/fake-agent.js";

type Frame = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const parse = (lines: readonly string[]): Frame[] => lines.map((l) => JSON.parse(l) as Frame);

const make = (script?: FakeScript, agentName = "coder"): FakeAgentCore =>
  new FakeAgentCore({ agentName, ...(script === undefined ? {} : { script }) });

const send = (core: FakeAgentCore, msg: object): Frame[] => parse(core.handleLine(JSON.stringify(msg)));

const newSession = (core: FakeAgentCore): string => {
  const [res] = send(core, { jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp/x", mcpServers: [] } });
  return res?.["result"].sessionId as string;
};

let nextId = 100;
const prompt = (core: FakeAgentCore, sessionId: string, text = "hi"): Frame[] =>
  send(core, {
    jsonrpc: "2.0",
    id: nextId++,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text }] },
  });

const cancel = (core: FakeAgentCore, sessionId: string): Frame[] =>
  send(core, { jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });

const stopReasons = (frames: readonly Frame[]): unknown[] =>
  frames.filter((f) => f["result"]?.stopReason !== undefined).map((f) => f["result"].stopReason);

describe("FakeAgentCore response shapes", () => {
  it("answers initialize with protocol version 1 and empty authMethods", () => {
    const [res] = send(make(), { jsonrpc: "2.0", id: "a", method: "initialize", params: {} });
    expect(res?.["id"]).toBe("a");
    expect(res?.["result"].protocolVersion).toBe(1);
    expect(res?.["result"].authMethods).toEqual([]);
    expect(res?.["result"].agentCapabilities).toBeDefined();
  });

  it("answers session/new with sessionId, modes and models", () => {
    const [res] = send(make(), { jsonrpc: "2.0", id: 7, method: "session/new", params: { cwd: "/tmp/x" } });
    expect(res?.["id"]).toBe(7);
    expect(typeof res?.["result"].sessionId).toBe("string");
    expect(Array.isArray(res?.["result"].modes.availableModes)).toBe(true);
    expect(res?.["result"].models.currentModelId).toBeDefined();
  });

  it("streams chunks as session/update then ends the turn with end_turn", () => {
    const core = make({ turns: [{ steps: [{ thought: "hm" }, { chunk: "pong" }] }] });
    const sid = newSession(core);
    const frames = prompt(core, sid);
    expect(frames.map((f) => f["params"]?.update?.sessionUpdate ?? "result")).toEqual([
      "agent_thought_chunk",
      "agent_message_chunk",
      "result",
    ]);
    expect(frames[1]?.["params"].update.content.text).toBe("pong");
    expect(stopReasons(frames)).toEqual(["end_turn"]);
  });

  it("echoes numeric and string request ids", () => {
    const core = make();
    const sid = newSession(core);
    const frames = send(core, { jsonrpc: "2.0", id: "str-id", method: "session/prompt", params: { sessionId: sid, prompt: [] } });
    expect(frames.find((f) => f["result"] !== undefined)?.["id"]).toBe("str-id");
  });

  it("emits permission requests with a string id by default and numeric when asked", () => {
    const tc = { kind: "edit", title: "Write", path: "a.txt" };
    const core = make({ turns: [{ steps: [{ permission: { toolCall: tc } }, { permission: { toolCall: tc, ids: "number" } }] }] });
    const sid = newSession(core);
    const first = prompt(core, sid);
    expect(typeof first[0]?.["id"]).toBe("string");
    expect(first[0]?.["method"]).toBe("session/request_permission");
    const second = send(core, { jsonrpc: "2.0", id: first[0]?.["id"], result: { outcome: { outcome: "selected", optionId: "allow_once" } } });
    expect(typeof second[0]?.["id"]).toBe("number");
    expect(core.dump().permissionAnswers[0]?.optionId).toBe("allow_once");
  });

  it("emits metadata with credits", () => {
    const core = make({ turns: [{ steps: [{ metadata: { turnDurationMs: 5, credits: [{ value: 0.5, unit: "credit" }] } }] }] });
    const frames = prompt(core, newSession(core));
    expect(frames[0]?.["method"]).toBe("_kiro.dev/metadata");
    expect(frames[0]?.["params"].meteringUsage).toEqual([{ value: 0.5, unit: "credit" }]);
  });
});

describe("FakeAgentCore end_turn vs cancelled", () => {
  it("resolves an in-flight prompt as cancelled on session/cancel", () => {
    const core = make({ turns: [{ steps: [{ chunk: "a" }, { delay: 5000 }, { chunk: "b" }] }] });
    const sid = newSession(core);
    const started = prompt(core, sid);
    expect(stopReasons(started)).toEqual([]);
    const after = cancel(core, sid);
    expect(stopReasons(after)).toEqual(["cancelled"]);
    expect(core.advance(10_000).some((l) => l.includes("agent_message_chunk"))).toBe(false);
  });

  it("honours an explicit stop step", () => {
    const core = make({ turns: [{ steps: [{ stop: "max_tokens" }] }] });
    expect(stopReasons(prompt(core, newSession(core)))).toEqual(["max_tokens"]);
  });
});

describe("FakeAgentCore cancel races", () => {
  const slow: FakeScript = { settleMs: 1000, turns: [{ steps: [{ delay: 5000 }] }, { steps: [{ chunk: "later" }] }] };

  it("answers a prompt inside the settle window as cancelled, and works after it", () => {
    const core = make(slow);
    const sid = newSession(core);
    prompt(core, sid);
    cancel(core, sid);
    expect(stopReasons(prompt(core, sid))).toEqual(["cancelled"]);
    core.advance(1000);
    expect(stopReasons(prompt(core, sid))).toEqual(["end_turn"]);
  });

  it("holds the settle window until scripted metadata arrives", () => {
    const core = make({ ...slow, metadataAfterCancel: true });
    const sid = newSession(core);
    prompt(core, sid);
    cancel(core, sid);
    const meta = parse(core.advance(1000));
    expect(meta.map((f) => f["method"])).toEqual(["_kiro.dev/metadata"]);
    expect(stopReasons(prompt(core, sid))).toEqual(["end_turn"]);
  });

  it("poisons the next prompt after a stray cancel with no turn in flight", () => {
    const core = make();
    const sid = newSession(core);
    cancel(core, sid);
    expect(core.dump().cancels).toEqual([{ sessionId: sid, inFlight: false }]);
    expect(stopReasons(prompt(core, sid))).toEqual(["cancelled"]);
    expect(stopReasons(prompt(core, sid))).toEqual(["end_turn"]);
  });
});

describe("FakeAgentCore invalid input", () => {
  it("answers non-JSON and non-JSON-RPC lines with an error and keeps running", () => {
    const core = make();
    const bad = parse(core.handleLine("not json {"));
    expect(bad[0]?.["error"].code).toBe(-32700);
    const wrong = parse(core.handleLine(JSON.stringify({ hello: "world" })));
    expect(wrong[0]?.["error"].code).toBe(-32600);
    expect(core.exitCode).toBeUndefined();
    const [ok] = send(core, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(ok?.["result"].protocolVersion).toBe(1);
  });

  it("answers unknown methods with method-not-found", () => {
    const [res] = send(make(), { jsonrpc: "2.0", id: 3, method: "nope" });
    expect(res?.["error"].code).toBe(-32601);
  });
});

describe("FakeAgentCore virtual time", () => {
  it("fires delays only on advance", () => {
    const core = make({ turns: [{ steps: [{ chunk: "a" }, { delay: 300 }, { chunk: "b" }] }] });
    const sid = newSession(core);
    expect(stopReasons(prompt(core, sid))).toEqual([]);
    expect(core.advance(299)).toEqual([]);
    const frames = parse(core.advance(1));
    expect(frames.map((f) => f["params"]?.update?.content?.text ?? "result")).toEqual(["b", "result"]);
    expect(stopReasons(frames)).toEqual(["end_turn"]);
    expect(core.virtualNow).toBe(300);
  });

  it("advances via fake/advance and reports the new time", () => {
    const core = make({ turns: [{ steps: [{ delay: 50 }] }] });
    const sid = newSession(core);
    prompt(core, sid);
    const frames = send(core, { jsonrpc: "2.0", id: 9, method: "fake/advance", params: { ms: 50 } });
    expect(stopReasons(frames)).toEqual(["end_turn"]);
    expect(frames.at(-1)?.["result"]).toEqual({ now: 50 });
  });
});

describe("FakeAgentCore session mode", () => {
  const mode = (core: FakeAgentCore): unknown => {
    const [res] = send(core, { jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp/x" } });
    return res?.["result"].modes.currentModeId;
  };

  it("defaults currentModeId to the launcher agent name", () => {
    expect(mode(make(undefined, "reviewer"))).toBe("reviewer");
  });

  it("uses the scripted modeId when set", () => {
    expect(mode(make({ turns: [], modeId: "kiro_default" }, "reviewer"))).toBe("kiro_default");
  });
});
