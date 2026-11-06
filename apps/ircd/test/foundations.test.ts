import { describe, expect, it } from "vitest";
import { serialize } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import { ChannelRegistry } from "../src/channel-registry.js";
import type { Client } from "../src/client.js";
import { nowMs, nowSeconds } from "../src/clock.js";
import type { RouterContext } from "../src/command-router.js";
import { ConnectionManager } from "../src/connection-manager.js";
import { packEntries } from "../src/entry-lines.js";
import { reflectedReply } from "../src/replies.js";
import { stripControl } from "../src/text-limits.js";

function makeCtx(now?: () => number): RouterContext {
  const channels = new ChannelRegistry();
  const connections = new ConnectionManager(channels.memberIdsLookup, {
    serverName: "irc.test",
  });
  return {
    connections,
    channels,
    serverName: "irc.test",
    logger: { error: () => {} },
    ...(now === undefined ? {} : { now }),
  };
}

function makeClient(nick: string): Client & { readonly sent: IrcMessage[] } {
  const sent: IrcMessage[] = [];
  return {
    id: nick,
    nick,
    user: nick,
    host: "host",
    registered: true,
    sent,
    send: (m) => {
      sent.push(m);
    },
    close: () => {},
  };
}

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

describe("clock", () => {
  it("nowMs uses the injected clock", () => {
    expect(nowMs(makeCtx(() => 1234))).toBe(1234);
  });

  it("nowSeconds floors the injected clock to whole seconds", () => {
    expect(nowSeconds(makeCtx(() => 1_999))).toBe(1);
    expect(nowSeconds(makeCtx(() => 5_000))).toBe(5);
  });

  it("defaults to Date.now", () => {
    const before = Math.floor(Date.now() / 1000);
    const got = nowSeconds(makeCtx());
    expect(got).toBeGreaterThanOrEqual(before);
    expect(got).toBeLessThanOrEqual(before + 1);
  });
});

describe("stripControl", () => {
  it("replaces CR, LF and NUL with a space", () => {
    expect(stripControl("a\rb\nc\0d")).toBe("a b c d");
    expect(stripControl("\r\n")).toBe("  ");
  });

  it("leaves other text untouched", () => {
    expect(stripControl("héllo 👻")).toBe("héllo 👻");
    expect(stripControl("")).toBe("");
  });
});

describe("packEntries", () => {
  const build = (joined: string): IrcMessage => ({
    prefix: "irc.test",
    command: "353",
    params: ["me", "=", "#c", joined],
  });

  it("gives no lines for no entries", () => {
    expect(packEntries([], build)).toEqual([]);
  });

  it("keeps a short list on one line", () => {
    const lines = packEntries(["a", "b", "c"], build);
    expect(lines).toEqual([build("a b c")]);
  });

  it("splits across lines without splitting an entry", () => {
    const entries = Array.from({ length: 60 }, (_, i) => `nick${i}-${"x".repeat(10)}`);
    const lines = packEntries(entries, build);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      expect(bytes(serialize(line))).toBeLessThanOrEqual(512);
    }
    const rejoined = lines.flatMap((l) => (l.params[3] ?? "").split(" "));
    expect(rejoined).toEqual(entries);
  });

  it("cuts an entry that cannot fit alone instead of throwing", () => {
    const huge = "é".repeat(400);
    const lines = packEntries(["a", huge, "b"], build);
    for (const line of lines) {
      expect(bytes(serialize(line))).toBeLessThanOrEqual(512);
    }
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines[0]?.params[3]).toBe("a");
  });
});

describe("reflectedReply", () => {
  const ctx = makeCtx();

  it("sends the value unchanged when it fits", () => {
    const c = makeClient("me");
    reflectedReply(ctx, c, "401", ["ghost"], "No such nick/channel");
    expect(c.sent).toEqual([
      {
        prefix: "irc.test",
        command: "401",
        params: ["me", "ghost", "No such nick/channel"],
      },
    ]);
  });

  it("clamps an oversized value on a code point boundary within 512 bytes", () => {
    const c = makeClient("me");
    reflectedReply(ctx, c, "401", ["👻".repeat(300)], "No such nick/channel");
    const msg = c.sent[0];
    expect(msg).toBeDefined();
    const value = msg?.params[1] ?? "";
    expect(bytes(serialize(msg as IrcMessage))).toBeLessThanOrEqual(512);
    expect(value.length).toBeGreaterThan(0);
    expect(value).not.toContain("\uFFFD");
    expect(value).toBe("👻".repeat([...value].length));
    expect([...value].length).toBeLessThan(300);
  });

  it("replaces spaces in the value", () => {
    const c = makeClient("me");
    reflectedReply(ctx, c, "401", ["a b c"], "text");
    expect(c.sent[0]?.params[1]).toBe("a_b_c");
  });

  it("removes a leading ':' from the value", () => {
    const c = makeClient("me");
    reflectedReply(ctx, c, "401", [":evil"], "text");
    const value = c.sent[0]?.params[1] ?? "";
    expect(value.startsWith(":")).toBe(false);
    expect(() => serialize(c.sent[0] as IrcMessage)).not.toThrow();
  });

  it("replaces an empty value with '*'", () => {
    const c = makeClient("me");
    reflectedReply(ctx, c, "401", [""], "text");
    expect(c.sent[0]?.params[1]).toBe("*");
  });
});
