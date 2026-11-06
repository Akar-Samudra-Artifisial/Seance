import { describe, expect, it } from "vitest";
import { serialize } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import { ChannelRegistry } from "../src/channel-registry.js";
import type { Client } from "../src/client.js";
import { CommandRouter } from "../src/command-router.js";
import type { RouterContext } from "../src/command-router.js";
import { ConnectionManager } from "../src/connection-manager.js";
import { registerJoinHandler } from "../src/handlers/join.js";

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
  const join = (c: Client, arg: string) =>
    router.dispatch(ctx, c, { command: "JOIN", params: [arg] });
  return { ctx, router, channels, add, join };
}

describe("JOIN handler", () => {
  it("creates the channel, auto-ops the creator and replies 331 + names", () => {
    const { add, join, channels } = setup();
    const alice = add("1", "alice");
    join(alice, "#test");
    expect(channels.isOp("#test", "1")).toBe(true);
    expect(alice.sent).toEqual([
      { prefix: "alice!alice@host", command: "JOIN", params: ["#test"] },
      { prefix: "irc.test", command: "331", params: ["alice", "#test", "No topic is set"] },
      { prefix: "irc.test", command: "353", params: ["alice", "=", "#test", "@alice"] },
      { prefix: "irc.test", command: "366", params: ["alice", "#test", "End of /NAMES list"] },
    ]);
  });

  it("broadcasts JOIN to existing members and the joiner, with 332 and @/+ prefixes", () => {
    const { add, join, channels } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    join(alice, "#test");
    const topicChannel = channels.get("#test");
    if (topicChannel === undefined) throw new Error("channel missing");
    topicChannel.topic = "hello world";
    alice.sent.length = 0;
    join(bob, "#TEST");
    const joinMsg = { prefix: "bob!bob@host", command: "JOIN", params: ["#test"] };
    expect(alice.sent).toEqual([joinMsg]);
    expect(bob.sent[0]).toEqual(joinMsg);
    expect(bob.sent[1]).toEqual({
      prefix: "irc.test",
      command: "332",
      params: ["bob", "#test", "hello world"],
    });
    expect(bob.sent[2]?.params[3]).toBe("@alice bob");
  });

  it("replies 403 for a name without #", () => {
    const { add, join } = setup();
    const alice = add("1", "alice");
    join(alice, "test");
    expect(alice.sent).toEqual([
      { prefix: "irc.test", command: "403", params: ["alice", "test", "No such channel"] },
    ]);
  });

  it("is a silent no-op when already a member", () => {
    const { add, join } = setup();
    const alice = add("1", "alice");
    join(alice, "#test");
    alice.sent.length = 0;
    join(alice, "#test");
    expect(alice.sent).toEqual([]);
  });

  it("processes a comma list in order despite a failing element", () => {
    const { add, join, channels } = setup();
    const alice = add("1", "alice");
    join(alice, "#a,bad,#b");
    expect(channels.isMember("#a", "1")).toBe(true);
    expect(channels.isMember("#b", "1")).toBe(true);
    const order = alice.sent.filter((m) => m.command === "JOIN" || m.command === "403");
    expect(order.map((m) => m.command)).toEqual(["JOIN", "403", "JOIN"]);
  });

  it("replies 461 with no channel parameter", () => {
    const { add, router, ctx } = setup();
    const alice = add("1", "alice");
    expect(router.dispatch(ctx, alice, { command: "JOIN", params: [] })).toBe("need-more-params");
    expect(alice.sent[0]?.command).toBe("461");
  });

  it("splits long 353 lists within 512 bytes without splitting nicks", () => {
    const { add, join } = setup();
    const nicks = Array.from({ length: 60 }, (_, i) => `user${String(i).padStart(2, "0")}${"é".repeat(10)}`);
    const clients = nicks.map((n, i) => add(String(i + 1), n));
    for (const c of clients) join(c, "#big");
    const last = clients[clients.length - 1];
    if (last === undefined) throw new Error("no clients");
    const names = last.sent.filter((m) => m.command === "353");
    expect(names.length).toBeGreaterThan(1);
    for (const m of names) {
      expect(Buffer.byteLength(serialize(m), "utf8")).toBeLessThanOrEqual(512);
    }
    const all = names.flatMap((m) => (m.params[3] ?? "").split(" ")).map((n) => n.replace(/^[@+]/, ""));
    expect([...all].sort()).toEqual([...nicks].sort());
    expect(last.sent[last.sent.length - 1]?.command).toBe("366");
  });
});
