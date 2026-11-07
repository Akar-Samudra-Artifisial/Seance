import type { IrcMessage } from "@seance/irc-protocol";
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../src/harness/harness.js";
import type { RunnerLogger } from "../src/log.js";
import { AgentOutput, AWAY_MAX_BYTES } from "../src/output/agent-output.js";
import { attachSessionOutput } from "../src/output/session-output.js";
import { SentenceBuffer } from "../src/output/sentence-buffer.js";
import type { HostVirtualClient } from "../src/ports.js";
import type { TurnEndingHook } from "../src/session/session.js";
import { WhoisSnapshot } from "../src/whois/snapshot.js";
import { ManualClock } from "./fixtures/manual-clock.js";

const CHANNEL = "#work";
const NICK = "coder";

const silentLogger = (errors: string[] = []): RunnerLogger => ({
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: (msg) => {
    errors.push(msg);
  },
});

type FakeClient = HostVirtualClient & {
  readonly sent: IrcMessage[];
  readonly aways: (string | undefined)[];
  failDispatch: boolean;
};

function fakeClient(): FakeClient {
  const sent: IrcMessage[] = [];
  const aways: (string | undefined)[] = [];
  const client = {
    id: "c1",
    nick: NICK,
    virtual: true,
    sent,
    aways,
    failDispatch: false,
    send: () => undefined,
    dispatch(msg: IrcMessage) {
      if (client.failDispatch) throw new Error("socket closed");
      sent.push(msg);
      return undefined;
    },
    onMessage: () => () => undefined,
    setAway(text?: string) {
      aways.push(text);
    },
    close: () => undefined,
  };
  return client;
}

function makeOutput(client: FakeClient, errors: string[] = [], snapshot?: WhoisSnapshot): AgentOutput {
  return new AgentOutput({
    client,
    logger: silentLogger(errors),
    nick: NICK,
    user: "coder",
    host: "seance.local",
    color: 4,
    ...(snapshot !== undefined ? { snapshot } : {}),
  });
}

function collect(clock: ManualClock) {
  const out: string[] = [];
  const buf = new SentenceBuffer({ clock, emit: (s) => out.push(s) });
  return { out, buf };
}

describe("SentenceBuffer", () => {
  it("does not split inside 3.14 or v1.2.3", () => {
    const { out, buf } = collect(new ManualClock());
    buf.append("Pi is 3.14 and the tag is v1.2.3 today. Next one. ");
    expect(out).toEqual(["Pi is 3.14 and the tag is v1.2.3 today.", "Next one."]);
    buf.flush();
    expect(out).toHaveLength(2);
  });

  it("holds an incomplete tail and joins it across chunks", () => {
    const { out, buf } = collect(new ManualClock());
    buf.append("Hello wor");
    expect(out).toEqual([]);
    buf.append("ld! More");
    expect(out).toEqual(["Hello world!"]);
    buf.append(" text. ");
    expect(out).toEqual(["Hello world!", "More text."]);
  });

  it("emits at Idle_Flush after 1500 ms, not before", () => {
    const clock = new ManualClock();
    const { out, buf } = collect(clock);
    buf.append("no terminator yet");
    clock.advance(1499);
    expect(out).toEqual([]);
    clock.advance(1);
    expect(out).toEqual(["no terminator yet"]);
    expect(clock.pending).toBe(0);
    buf.dispose();
  });

  it("restarts the idle timer on each chunk", () => {
    const clock = new ManualClock();
    const { out, buf } = collect(clock);
    buf.append("part one ");
    clock.advance(1000);
    buf.append("part two");
    clock.advance(1000);
    expect(out).toEqual([]);
    clock.advance(500);
    expect(out).toEqual(["part one part two"]);
  });

  it("flush() emits the remainder and cancels the idle timer", () => {
    const clock = new ManualClock();
    const { out, buf } = collect(clock);
    buf.append("tail without end");
    buf.flush();
    expect(out).toEqual(["tail without end"]);
    expect(clock.pending).toBe(0);
    clock.advance(5000);
    expect(out).toHaveLength(1);
  });

  it("emits nothing for whitespace-only text", () => {
    const clock = new ManualClock();
    const { out, buf } = collect(clock);
    buf.append("  \t ");
    buf.flush();
    clock.advance(5000);
    expect(out).toEqual([]);
  });
});

describe("AgentOutput", () => {
  it("says text as a plain PRIVMSG even when it looks like a command", () => {
    const client = fakeClient();
    makeOutput(client).say(CHANNEL, "/kick x");
    expect(client.sent).toHaveLength(1);
    const msg = client.sent[0];
    expect(msg?.command).toBe("PRIVMSG");
    expect(msg?.params[0]).toBe(CHANNEL);
    expect(msg?.params[1]).toContain("/kick x");
    expect(client.sent.every((m) => m.command === "PRIVMSG")).toBe(true);
  });

  it("sets AWAY clamped to 200 bytes at a code point boundary and mirrors it in the snapshot", () => {
    const client = fakeClient();
    const snapshot = new WhoisSnapshot();
    const out = makeOutput(client, [], snapshot);
    // 3-byte characters: 200 is not a multiple of 3, so the cut must fall back to 198.
    out.toolStarted(CHANNEL, "日".repeat(100));
    const away = client.aways[0];
    expect(away).toBeDefined();
    expect(Buffer.byteLength(away ?? "", "utf8")).toBe(198);
    expect(Buffer.byteLength(away ?? "", "utf8")).toBeLessThanOrEqual(AWAY_MAX_BYTES);
    expect(away).toBe("日".repeat(66));
    expect(snapshot.get(NICK)?.away).toBe(away);
    const notice = client.sent[0];
    expect(notice?.command).toBe("NOTICE");
    expect(notice?.params[0]).toBe(CHANNEL);
  });

  it("clearAway clears AWAY and the snapshot", () => {
    const client = fakeClient();
    const snapshot = new WhoisSnapshot();
    const out = makeOutput(client, [], snapshot);
    out.toolStarted(CHANNEL, "using tool: write");
    out.clearAway();
    expect(client.aways).toEqual(["using tool: write", undefined]);
    expect(snapshot.get(NICK)?.away).toBeUndefined();
  });

  it("logs a dispatch failure, drops the line and keeps working", () => {
    const client = fakeClient();
    const errors: string[] = [];
    const out = makeOutput(client, errors);
    client.failDispatch = true;
    expect(() => {
      out.say(CHANNEL, "lost line");
    }).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(client.sent).toEqual([]);
    client.failDispatch = false;
    out.say(CHANNEL, "next line");
    expect(client.sent).toHaveLength(1);
  });
});

describe("attachSessionOutput", () => {
  function setup() {
    const clock = new ManualClock();
    const client = fakeClient();
    const output = makeOutput(client);
    const eventListeners = new Set<(e: SessionEvent) => void>();
    const endingListeners = new Set<TurnEndingHook>();
    const session = {
      channel: CHANNEL,
      sessionEvents: (l: (e: SessionEvent) => void) => {
        eventListeners.add(l);
        return () => eventListeners.delete(l);
      },
      turnEnding: (l: TurnEndingHook) => {
        endingListeners.add(l);
        return () => endingListeners.delete(l);
      },
    };
    const detach = attachSessionOutput({ session, output, clock });
    return {
      clock,
      client,
      detach,
      emit: (e: SessionEvent) => {
        for (const l of eventListeners) l(e);
      },
      endTurn: () => {
        for (const l of endingListeners) l("end_turn");
      },
    };
  }

  const texts = (c: FakeClient): string[] => c.sent.map((m) => m.params[1] ?? "");

  it("flushes the buffer and clears AWAY at the end of the Turn", () => {
    const s = setup();
    s.emit({ kind: "message-chunk", text: "Almost done" });
    expect(s.client.sent).toEqual([]);
    s.emit({ kind: "tool-call", tool: { kind: "edit", title: "write file", paths: [] } });
    expect(s.client.aways).toEqual(["using tool: write file"]);
    s.emit({ kind: "message-chunk", text: "final words" });
    s.endTurn();
    expect(texts(s.client).some((t) => t.includes("final words"))).toBe(true);
    expect(s.client.aways.at(-1)).toBeUndefined();
    expect(s.client.aways).toHaveLength(2);
  });

  it("says buffered text at Idle_Flush using the injected clock", () => {
    const s = setup();
    s.emit({ kind: "message-chunk", text: "waiting" });
    s.clock.advance(1500);
    expect(texts(s.client).some((t) => t.includes("waiting"))).toBe(true);
  });

  it("sends nothing for thought chunks, metadata and unknown updates", () => {
    const s = setup();
    s.emit({ kind: "thought-chunk", text: "secret reasoning." });
    s.emit({ kind: "unknown", sessionUpdate: "plan" });
    s.emit({ kind: "metadata", metering: [] });
    s.clock.advance(5000);
    expect(s.client.sent).toEqual([]);
    expect(s.client.aways).toEqual([]);
  });

  it("survives a failing dispatch and keeps delivering later output", () => {
    const s = setup();
    s.client.failDispatch = true;
    s.emit({ kind: "message-chunk", text: "First. " });
    expect(() => {
      s.endTurn();
    }).not.toThrow();
    s.client.failDispatch = false;
    s.emit({ kind: "message-chunk", text: "Second. " });
    expect(texts(s.client).some((t) => t.includes("Second."))).toBe(true);
  });

  it("detaches and leaves no timers", () => {
    const s = setup();
    s.emit({ kind: "message-chunk", text: "pending" });
    s.detach();
    expect(s.clock.pending).toBe(0);
    s.emit({ kind: "message-chunk", text: "ignored. " });
    expect(s.client.sent).toEqual([]);
  });
});
