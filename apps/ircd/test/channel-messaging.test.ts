import { describe, expect, it } from "vitest";
import type { IrcMessage } from "@seance/irc-protocol";
import { ChannelRegistry } from "../src/channel-registry.js";
import type { Client } from "../src/client.js";
import { CommandRouter } from "../src/command-router.js";
import type { RouterContext } from "../src/command-router.js";
import { ConnectionManager } from "../src/connection-manager.js";
import { registerJoinHandler } from "../src/handlers/join.js";
import { registerListHandler } from "../src/handlers/list.js";
import { registerNamesHandler } from "../src/handlers/names.js";
import { registerNoticeHandler } from "../src/handlers/notice.js";
import { registerPartHandler } from "../src/handlers/part.js";
import { registerPrivmsgHandler } from "../src/handlers/privmsg.js";
import { registerTopicHandler } from "../src/handlers/topic.js";

type TestClient = Client & { readonly sent: IrcMessage[] };

function makeClient(id: string, nick: string): TestClient {
  const sent: IrcMessage[] = [];
  return {
    id,
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

function setup() {
  const channels = new ChannelRegistry();
  const connections = new ConnectionManager(channels.memberIdsLookup, {
    serverName: "irc.test",
  });
  const router = new CommandRouter();
  registerJoinHandler(router);
  registerPartHandler(router);
  registerPrivmsgHandler(router);
  registerNoticeHandler(router);
  registerTopicHandler(router);
  registerNamesHandler(router);
  registerListHandler(router);
  const ctx: RouterContext = {
    connections,
    channels,
    serverName: "irc.test",
    logger: { error: () => {} },
  };
  const add = (id: string, nick: string): TestClient => {
    const c = makeClient(id, nick);
    connections.add(c);
    return c;
  };
  const run = (c: Client, command: string, ...params: string[]) =>
    router.dispatch(ctx, c, { command, params });
  return { ctx, channels, add, run };
}

const codes = (c: TestClient): string[] => c.sent.map((m) => m.command);

describe("channel and messaging handlers (cross-cutting edge cases)", () => {
  it("JOIN rejects names with spaces, control chars, or excessive length with 403 and creates nothing", () => {
    const { add, run, channels } = setup();
    const alice = add("1", "alice");
    run(alice, "JOIN", "#a b");
    run(alice, "JOIN", "#bell\x07");
    run(alice, "JOIN", `#${"x".repeat(300)}`);
    expect(codes(alice)).toEqual(["403", "403", "403"]);
    expect(channels.has("#a b")).toBe(false);
  });

  it("JOIN skips empty list elements and still joins the valid ones", () => {
    const { add, run, channels } = setup();
    const alice = add("1", "alice");
    run(alice, "JOIN", "#a,,#b");
    expect(channels.isMember("#a", "1")).toBe(true);
    expect(channels.isMember("#b", "1")).toBe(true);
    expect(codes(alice).filter((c) => c === "403")).toEqual([]);
  });

  it("JOIN of an existing topic is delivered as 332 even after the topic was cleared and reset", () => {
    const { add, run } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    run(alice, "JOIN", "#t");
    run(alice, "TOPIC", "#t", "first");
    run(alice, "TOPIC", "#t", "");
    run(alice, "TOPIC", "#t", "second");
    run(bob, "JOIN", "#t");
    expect(bob.sent[1]).toEqual({
      prefix: "irc.test",
      command: "332",
      params: ["bob", "#t", "second"],
    });
  });

  it("PART with a bad channel name replies 403 and leaves membership intact", () => {
    const { add, run, channels } = setup();
    const alice = add("1", "alice");
    run(alice, "JOIN", "#a");
    alice.sent.length = 0;
    run(alice, "PART", "nohash");
    expect(codes(alice)).toEqual(["403"]);
    expect(channels.isMember("#a", "1")).toBe(true);
  });

  it("the last member leaving one channel of several removes only that channel", () => {
    const { add, run, channels } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    run(alice, "JOIN", "#a,#b");
    run(bob, "JOIN", "#b");
    run(alice, "PART", "#a,#b");
    expect(channels.has("#a")).toBe(false);
    expect(channels.has("#b")).toBe(true);
    expect(channels.isOp("#b", "2")).toBe(false);
  });

  it("PRIVMSG to a channel never sends 301 even when members are away", () => {
    const { add, run } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    bob.away = "brb";
    run(alice, "JOIN", "#t");
    run(bob, "JOIN", "#t");
    alice.sent.length = 0;
    bob.sent.length = 0;
    run(alice, "PRIVMSG", "#t", "hi");
    expect(alice.sent).toEqual([]);
    expect(codes(bob)).toEqual(["PRIVMSG"]);
  });

  it("PRIVMSG replies 401 for a nick that is connected but not yet registered", () => {
    const { ctx, add, run } = setup();
    const alice = add("1", "alice");
    const pending = makeClient("2", "pending");
    (pending as { registered: boolean }).registered = false;
    ctx.connections.add(pending);
    run(alice, "PRIVMSG", "pending", "hi");
    expect(codes(alice)).toEqual(["401"]);
    expect(pending.sent).toEqual([]);
  });

  it("a voiced (non-op) member can speak under +m but gets 482 on TOPIC set", () => {
    const { add, run, channels } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    run(alice, "JOIN", "#t");
    run(bob, "JOIN", "#t");
    const ch = channels.get("#t");
    const entry = ch?.members.get("2");
    if (ch === undefined || entry === undefined) throw new Error("setup failed");
    ch.modes.moderated = true;
    entry.voice = true;
    alice.sent.length = 0;
    bob.sent.length = 0;
    run(bob, "PRIVMSG", "#t", "voiced");
    run(bob, "TOPIC", "#t", "nope");
    expect(codes(alice)).toEqual(["PRIVMSG"]);
    expect(codes(bob)).toEqual(["482"]);
    expect(ch.topic).toBeUndefined();
  });

  it("TOPIC for a bad-name channel replies 403", () => {
    const { add, run } = setup();
    const alice = add("1", "alice");
    run(alice, "TOPIC", "nohash", "x");
    expect(codes(alice)).toEqual(["403"]);
  });

  it("NOTICE from a voiced member under +m is delivered; to an away user without 301", () => {
    const { add, run, channels } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    run(alice, "JOIN", "#t");
    run(bob, "JOIN", "#t");
    const ch = channels.get("#t");
    const entry = ch?.members.get("2");
    if (ch === undefined || entry === undefined) throw new Error("setup failed");
    ch.modes.moderated = true;
    entry.voice = true;
    alice.sent.length = 0;
    run(bob, "NOTICE", "#t", "voiced notice");
    expect(alice.sent).toEqual([
      { prefix: "bob!bob@host", command: "NOTICE", params: ["#t", "voiced notice"] },
    ]);
    expect(bob.sent.filter((m) => m.command !== "JOIN" && m.command !== "331" && m.command !== "353" && m.command !== "366")).toEqual([]);
  });

  it("NOTICE stays silent for a bad channel name and a non-existent nick in one session", () => {
    const { add, run } = setup();
    const alice = add("1", "alice");
    run(alice, "NOTICE", "nohash-nick", "x");
    run(alice, "NOTICE", "#bad name", "x");
    expect(alice.sent).toEqual([]);
  });

  it("NAMES shows @ for a member who is both op and voiced (op wins, no double prefix)", () => {
    const { add, run, channels } = setup();
    const alice = add("1", "alice");
    run(alice, "JOIN", "#t");
    const entry = channels.get("#t")?.members.get("1");
    if (entry === undefined) throw new Error("setup failed");
    entry.voice = true;
    alice.sent.length = 0;
    run(alice, "NAMES", "#t");
    expect(alice.sent[0]?.params[3]).toBe("@alice");
  });

  it("NAMES for a channel emptied by PART replies only 366", () => {
    const { add, run } = setup();
    const alice = add("1", "alice");
    run(alice, "JOIN", "#t");
    run(alice, "PART", "#t");
    alice.sent.length = 0;
    run(alice, "NAMES", "#t");
    expect(codes(alice)).toEqual(["366"]);
  });

  it("LIST reports an updated topic and member count after joins and parts", () => {
    const { add, run } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    run(alice, "JOIN", "#t");
    run(bob, "JOIN", "#t");
    run(alice, "TOPIC", "#t", "plan");
    run(bob, "PART", "#t");
    alice.sent.length = 0;
    run(alice, "LIST");
    expect(alice.sent.map((m) => m.params)).toEqual([
      ["alice", "#t", "1", "plan"],
      ["alice", "End of /LIST"],
    ]);
    expect(codes(alice)).toEqual(["322", "323"]);
  });

  it("LIST with only unknown names sends just 323", () => {
    const { add, run } = setup();
    const alice = add("1", "alice");
    run(alice, "LIST", "#nope");
    expect(codes(alice)).toEqual(["323"]);
  });
});
