import { describe, expect, it } from "vitest";
import type { IrcMessage } from "@seance/irc-protocol";
import { ChannelRegistry } from "../src/channel-registry.js";
import type { Client } from "../src/client.js";
import { CommandRouter } from "../src/command-router.js";
import type { RouterContext } from "../src/command-router.js";
import { ConnectionManager } from "../src/connection-manager.js";
import { registerJoinHandler } from "../src/handlers/join.js";
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
  registerTopicHandler(router);
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
  const topic = (c: Client, ...params: string[]) =>
    router.dispatch(ctx, c, { command: "TOPIC", params });
  return { ctx, router, channels, add, join, topic };
}

describe("TOPIC handler", () => {
  it("replies 331 when no topic is set", () => {
    const { add, join, topic } = setup();
    const alice = add("1", "alice");
    join(alice, "#test");
    alice.sent.length = 0;
    topic(alice, "#test");
    expect(alice.sent).toEqual([
      { prefix: "irc.test", command: "331", params: ["alice", "#test", "No topic is set"] },
    ]);
  });

  it("op sets topic, broadcasts to all members including sender, query gives 332", () => {
    const { add, join, topic } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    join(alice, "#test");
    join(bob, "#test");
    alice.sent.length = 0;
    bob.sent.length = 0;
    topic(alice, "#test", "build the thing");
    const msg = { prefix: "alice!alice@host", command: "TOPIC", params: ["#test", "build the thing"] };
    expect(alice.sent).toEqual([msg]);
    expect(bob.sent).toEqual([msg]);
    bob.sent.length = 0;
    topic(bob, "#test");
    expect(bob.sent).toEqual([
      { prefix: "irc.test", command: "332", params: ["bob", "#test", "build the thing"] },
    ]);
  });

  it("matches the channel name case-insensitively and broadcasts the canonical name", () => {
    const { add, join, topic, channels } = setup();
    const alice = add("1", "alice");
    join(alice, "#Test");
    alice.sent.length = 0;
    topic(alice, "#TEST", "hi");
    expect(alice.sent[0]?.params).toEqual(["#Test", "hi"]);
    expect(channels.get("#test")?.topic).toBe("hi");
  });

  it("replies 482 to a non-op and leaves the topic unchanged", () => {
    const { add, join, topic, channels } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    join(alice, "#test");
    join(bob, "#test");
    topic(alice, "#test", "original");
    alice.sent.length = 0;
    bob.sent.length = 0;
    topic(bob, "#test", "hijack");
    expect(bob.sent).toEqual([
      { prefix: "irc.test", command: "482", params: ["bob", "#test", "You're not channel operator"] },
    ]);
    expect(alice.sent).toEqual([]);
    expect(channels.get("#test")?.topic).toBe("original");
  });

  it("replies 442 to a non-member for query and set", () => {
    const { add, join, topic, channels } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    join(alice, "#test");
    topic(bob, "#test");
    topic(bob, "#test", "nope");
    const err = { prefix: "irc.test", command: "442", params: ["bob", "#test", "You're not on that channel"] };
    expect(bob.sent).toEqual([err, err]);
    expect(channels.get("#test")?.topic).toBeUndefined();
  });

  it("replies 403 for a missing channel", () => {
    const { add, topic } = setup();
    const alice = add("1", "alice");
    topic(alice, "#nope");
    expect(alice.sent).toEqual([
      { prefix: "irc.test", command: "403", params: ["alice", "#nope", "No such channel"] },
    ]);
  });

  it("replies 461 with no channel parameter", () => {
    const { add, topic } = setup();
    const alice = add("1", "alice");
    expect(topic(alice)).toBe("need-more-params");
    expect(alice.sent[0]?.command).toBe("461");
  });

  it("clears the topic with an empty string", () => {
    const { add, join, topic } = setup();
    const alice = add("1", "alice");
    join(alice, "#test");
    topic(alice, "#test", "something");
    alice.sent.length = 0;
    topic(alice, "#test", "");
    expect(alice.sent).toEqual([
      { prefix: "alice!alice@host", command: "TOPIC", params: ["#test", ""] },
    ]);
    alice.sent.length = 0;
    topic(alice, "#test");
    expect(alice.sent[0]?.command).toBe("331");
  });
});
