import { describe, expect, it } from "vitest";
import type { IrcMessage } from "@seance/irc-protocol";
import { ChannelRegistry } from "../src/channel-registry.js";
import type { Client } from "../src/client.js";
import { CommandRouter } from "../src/command-router.js";
import type { RouterContext } from "../src/command-router.js";
import { ConnectionManager } from "../src/connection-manager.js";
import { registerJoinHandler } from "../src/handlers/join.js";
import { registerListHandler } from "../src/handlers/list.js";

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
  const join = (c: Client, arg: string) =>
    router.dispatch(ctx, c, { command: "JOIN", params: [arg] });
  const list = (c: Client, ...params: string[]) =>
    router.dispatch(ctx, c, { command: "LIST", params });
  return { ctx, channels, add, join, list };
}

const entry = (nick: string, name: string, count: string, topic: string): IrcMessage => ({
  prefix: "irc.test",
  command: "322",
  params: [nick, name, count, topic],
});
const listEnd = (nick: string): IrcMessage => ({
  prefix: "irc.test",
  command: "323",
  params: [nick, "End of /LIST"],
});

describe("LIST handler", () => {
  it("sends only 323 when no channels exist", () => {
    const { add, list } = setup();
    const alice = add("1", "alice");
    list(alice);
    expect(alice.sent).toEqual([listEnd("alice")]);
  });

  it("sends one 322 per channel with counts and topics, then a single 323", () => {
    const { add, join, list, channels } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    join(alice, "#a");
    join(bob, "#a");
    join(alice, "#b");
    const topic = channels.get("#a");
    if (topic === undefined) throw new Error("#a should exist");
    topic.topic = "héllo wörld";
    alice.sent.length = 0;
    list(alice);
    expect(alice.sent).toEqual([
      entry("alice", "#a", "2", "héllo wörld"),
      entry("alice", "#b", "1", ""),
      listEnd("alice"),
    ]);
  });

  it("omits a channel once its last member parts", () => {
    const { add, join, list, ctx } = setup();
    const alice = add("1", "alice");
    join(alice, "#a");
    join(alice, "#b");
    ctx.channels.part("1", "#a");
    alice.sent.length = 0;
    list(alice);
    expect(alice.sent).toEqual([entry("alice", "#b", "1", ""), listEnd("alice")]);
  });

  it("filters by name case-insensitively, reports the canonical name and skips missing channels", () => {
    const { add, join, list } = setup();
    const alice = add("1", "alice");
    join(alice, "#Test");
    join(alice, "#other");
    alice.sent.length = 0;
    list(alice, "#TEST,#missing");
    expect(alice.sent).toEqual([entry("alice", "#Test", "1", ""), listEnd("alice")]);
  });
});
