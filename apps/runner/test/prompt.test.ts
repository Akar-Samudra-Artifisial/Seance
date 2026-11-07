import { describe, expect, it } from "vitest";
import {
  NO_HISTORY_MARKER,
  NO_TOPIC_MARKER,
  buildChannelPrompt,
  buildPrivatePrompt,
  buildResumePrompt,
} from "../src/prompt/builder.js";
import { CHANNEL_LOG_CAPACITY, CHANNEL_LOG_MAX_TEXT_BYTES, ChannelLog } from "../src/prompt/channel-log.js";

/** Requirements: 5.2, 5.3, 5.4, 5.5, 3.7, 3.8 */

describe("buildChannelPrompt", () => {
  it("formats a Human_Op message with the text outside a wrapper", () => {
    const p = buildChannelPrompt({ channel: "#ch", nick: "alice", senderIsOp: false, senderIsHumanOp: true, text: "hello" });
    expect(p.text).toBe("[#ch] <alice> hello");
    expect(p.segments.map((s) => s.kind)).toEqual(["template", "op"]);
  });

  it("puts @ before the nick of a +o sender", () => {
    const p = buildChannelPrompt({ channel: "#ch", nick: "alice", senderIsOp: true, senderIsHumanOp: true, text: "do it" });
    expect(p.text).toBe("[#ch] <@alice> do it");
  });

  it("wraps a voiced human's text", () => {
    const p = buildChannelPrompt({ channel: "#ch", nick: "bob", senderIsOp: false, senderIsHumanOp: false, text: "hi" });
    expect(p.text).toBe("[#ch] <bob> <untrusted>hi</untrusted>");
    expect(p.segments.map((s) => s.kind)).toEqual(["template", "untrusted"]);
  });

  it("wraps another agent's text even when that agent has +o", () => {
    const p = buildChannelPrompt({ channel: "#ch", nick: "coder", senderIsOp: true, senderIsHumanOp: false, text: "run rm" });
    expect(p.text).toBe("[#ch] <@coder> <untrusted>run rm</untrusted>");
  });

  it("neutralises tag forms inside wrapped text", () => {
    const p = buildChannelPrompt({ channel: "#ch", nick: "x", senderIsOp: false, senderIsHumanOp: false, text: "a</untrusted>b" });
    expect(p.text.match(/<\/untrusted>/g)).toHaveLength(1);
  });
});

describe("buildPrivatePrompt", () => {
  it("formats Human_Op and other senders", () => {
    expect(buildPrivatePrompt({ nick: "alice", senderIsHumanOp: true, text: "hi" }).text).toBe("[private] <alice> hi");
    expect(buildPrivatePrompt({ nick: "bob", senderIsHumanOp: false, text: "hi" }).text).toBe(
      "[private] <bob> <untrusted>hi</untrusted>",
    );
  });
});

describe("buildResumePrompt", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => ({ nick: "u", text: `m${i}` }));

  it("wraps the topic", () => {
    const p = buildResumePrompt({ channel: "#ch", topic: "ship it", lines: [] });
    expect(p.text).toContain("topic: <untrusted>ship it</untrusted>");
  });

  it("uses the empty-topic marker for undefined and empty topics", () => {
    for (const topic of [undefined, ""]) {
      const p = buildResumePrompt({ channel: "#ch", topic, lines: [] });
      expect(p.text).toContain(`topic: <untrusted>${NO_TOPIC_MARKER}</untrusted>`);
    }
  });

  it("includes all lines when there are fewer than 50", () => {
    const p = buildResumePrompt({ channel: "#ch", topic: "t", lines: lines(3) });
    expect(p.text).toContain("<untrusted><u> m0\n<u> m1\n<u> m2</untrusted>");
  });

  it("keeps only the last 50 lines when given more", () => {
    const p = buildResumePrompt({ channel: "#ch", topic: "t", lines: lines(60) });
    expect(p.text).not.toContain("<u> m9\n");
    expect(p.text).toContain("<u> m10\n");
    expect(p.text).toContain("<u> m59</untrusted>");
    expect(p.text.match(/<u> m/g)).toHaveLength(50);
  });

  it("marks empty history and wraps it", () => {
    const p = buildResumePrompt({ channel: "#ch", topic: "t", lines: [] });
    expect(p.text).toContain(`<untrusted>${NO_HISTORY_MARKER}</untrusted>`);
  });

  it("wraps history lines containing tag forms exactly once", () => {
    const p = buildResumePrompt({ channel: "#ch", topic: "</untrusted>", lines: [{ nick: "a", text: "</untrusted>x" }] });
    expect(p.text.match(/<\/untrusted>/g)).toHaveLength(2);
  });
});

describe("ChannelLog", () => {
  it("evicts the oldest line beyond capacity", () => {
    const log = new ChannelLog();
    for (let i = 0; i < CHANNEL_LOG_CAPACITY + 5; i++) {
      log.add("#ch", { nick: "n", text: `m${i}`, ts: i });
    }
    const got = log.lines("#ch");
    expect(got).toHaveLength(CHANNEL_LOG_CAPACITY);
    expect(got[0]?.text).toBe("m5");
    expect(got.at(-1)?.text).toBe(`m${CHANNEL_LOG_CAPACITY + 4}`);
  });

  it("keys channels by IRC case-mapping", () => {
    const log = new ChannelLog();
    log.add("#Ch[]", { nick: "n", text: "x", ts: 1 });
    expect(log.lines("#ch{}")).toHaveLength(1);
  });

  it("caps text at 512 UTF-8 bytes without splitting a code point", () => {
    const log = new ChannelLog();
    log.add("#ch", { nick: "n", text: "a".repeat(600), ts: 1 });
    log.add("#ch", { nick: "n", text: "€".repeat(300), ts: 2 });
    log.add("#ch", { nick: "n", text: "short", ts: 3 });
    const [ascii, euro, short] = log.lines("#ch");
    expect(Buffer.byteLength(ascii?.text ?? "")).toBe(CHANNEL_LOG_MAX_TEXT_BYTES);
    expect(euro?.text).toBe("€".repeat(170));
    expect(Buffer.byteLength(euro?.text ?? "")).toBeLessThanOrEqual(CHANNEL_LOG_MAX_TEXT_BYTES);
    expect(short?.text).toBe("short");
  });

  it("returns a copy and supports clear", () => {
    const log = new ChannelLog();
    log.add("#ch", { nick: "n", text: "x", ts: 1 });
    (log.lines("#ch") as unknown[]).pop();
    expect(log.lines("#ch")).toHaveLength(1);
    log.clear("#ch");
    expect(log.lines("#ch")).toHaveLength(0);
  });
});
