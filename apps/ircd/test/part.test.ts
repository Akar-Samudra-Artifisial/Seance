import { describe, expect, it } from "vitest";
import type { IrcMessage } from "@seance/irc-protocol";
import { ChannelRegistry } from "../src/channel-registry.js";
import type { Client } from "../src/client.js";
import { CommandRouter } from "../src/command-router.js";
import type { RouterContext } from "../src/command-router.js";
import { ConnectionManager } from "../src/connection-manager.js";
import { registerJoinHandler } from "../src/handlers/join.js";
import { registerPartHandler } from "../src/handlers/part.js";

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
  const part = (c: Client, ...params: string[]) =>
    router.dispatch(ctx, c, { command: "PART", params });
  return { ctx, router, channels, add, join, part };
}

describe("PART handler", () => {
  it("broadcasts PART with a reason to all members including the leaver", () => {
    const { add, join, part, channels } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    join(alice, "#test");
    join(bob, "#test");
    alice.sent.length = 0;
    bob.sent.length = 0;
    part(bob, "#test", "bye now");
    const msg = { prefix: "bob!bob@host", command: "PART", params: ["#test", "bye now"] };
    expect(alice.sent).toEqual([msg]);
    expect(bob.sent).toEqual([msg]);
    expect(channels.isMember("#test", "2")).toBe(false);
    expect(channels.isMember("#test", "1")).toBe(true);
  });

  it("omits the reason param when none is given", () => {
    const { add, join, part } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    join(alice, "#test");
    join(bob, "#test");
    alice.sent.length = 0;
    part(bob, "#TEST");
    expect(alice.sent).toEqual([
      { prefix: "bob!bob@host", command: "PART", params: ["#test"] },
    ]);
  });

  it("replies 442 when not a member and does not broadcast", () => {
    const { add, join, part } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    join(alice, "#test");
    alice.sent.length = 0;
    part(bob, "#test");
    expect(bob.sent).toEqual([
      { prefix: "irc.test", command: "442", params: ["bob", "#test", "You're not on that channel"] },
    ]);
    expect(alice.sent).toEqual([]);
  });

  it("replies 403 for a channel that does not exist", () => {
    const { add, part } = setup();
    const alice = add("1", "alice");
    part(alice, "#nope");
    expect(alice.sent).toEqual([
      { prefix: "irc.test", command: "403", params: ["alice", "#nope", "No such channel"] },
    ]);
  });

  it("removes the empty channel and discards its topic", () => {
    const { add, join, part, channels } = setup();
    const alice = add("1", "alice");
    join(alice, "#test");
    const ch = channels.get("#test");
    if (ch === undefined) throw new Error("channel missing");
    ch.topic = "secret";
    ch.modes.moderated = true;
    part(alice, "#test");
    expect(channels.has("#test")).toBe(false);
    alice.sent.length = 0;
    join(alice, "#test");
    expect(alice.sent[1]?.command).toBe("331");
    expect(channels.get("#test")?.modes.moderated).toBe(false);
  });

  it("processes a comma list in order despite a failing element", () => {
    const { add, join, part, channels } = setup();
    const alice = add("1", "alice");
    join(alice, "#a");
    join(alice, "#b");
    alice.sent.length = 0;
    part(alice, "#a,#missing,#b");
    expect(alice.sent.map((m) => m.command)).toEqual(["PART", "403", "PART"]);
    expect(channels.has("#a")).toBe(false);
    expect(channels.has("#b")).toBe(false);
  });

  it("replies 461 with no channel parameter", () => {
    const { add, router, ctx } = setup();
    const alice = add("1", "alice");
    expect(router.dispatch(ctx, alice, { command: "PART", params: [] })).toBe("need-more-params");
    expect(alice.sent[0]?.command).toBe("461");
  });
});
