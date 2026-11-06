import { describe, expect, it } from "vitest";
import type { IrcMessage } from "@seance/irc-protocol";
import { ChannelRegistry } from "../src/channel-registry.js";
import type { Client } from "../src/client.js";
import { CommandRouter } from "../src/command-router.js";
import type { RouterContext } from "../src/command-router.js";
import { ConnectionManager } from "../src/connection-manager.js";
import { registerJoinHandler } from "../src/handlers/join.js";
import { registerPrivmsgHandler } from "../src/handlers/privmsg.js";

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
  registerPrivmsgHandler(router);
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
  const privmsg = (c: Client, ...params: string[]) =>
    router.dispatch(ctx, c, { command: "PRIVMSG", params });
  return { ctx, channels, add, join, privmsg };
}

const err = (code: string, ...params: string[]): IrcMessage => ({
  prefix: "irc.test",
  command: code,
  params,
});

describe("PRIVMSG handler", () => {
  it("relays to channel members except the sender", () => {
    const { add, join, privmsg } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    const carol = add("3", "carol");
    join(alice, "#test");
    join(bob, "#test");
    join(carol, "#other");
    for (const c of [alice, bob, carol]) c.sent.length = 0;
    privmsg(alice, "#TEST", "hello there");
    expect(bob.sent).toEqual([
      { prefix: "alice!alice@host", command: "PRIVMSG", params: ["#test", "hello there"] },
    ]);
    expect(alice.sent).toEqual([]);
    expect(carol.sent).toEqual([]);
  });

  it("relays a private message to the target only, case-insensitively", () => {
    const { add, privmsg } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "Bob");
    const carol = add("3", "carol");
    privmsg(alice, "bOb", "psst");
    expect(bob.sent).toEqual([
      { prefix: "alice!alice@host", command: "PRIVMSG", params: ["bOb", "psst"] },
    ]);
    expect(alice.sent).toEqual([]);
    expect(carol.sent).toEqual([]);
  });

  it("replies 401 for an unknown nick", () => {
    const { add, privmsg } = setup();
    const alice = add("1", "alice");
    privmsg(alice, "ghost", "hi");
    expect(alice.sent).toEqual([err("401", "alice", "ghost", "No such nick/channel")]);
  });

  it("replies 403 for an unknown channel", () => {
    const { add, privmsg } = setup();
    const alice = add("1", "alice");
    privmsg(alice, "#nope", "hi");
    expect(alice.sent).toEqual([err("403", "alice", "#nope", "No such channel")]);
  });

  it("replies 404 to a non-member and does not deliver", () => {
    const { add, join, privmsg } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    join(alice, "#test");
    alice.sent.length = 0;
    privmsg(bob, "#test", "hi");
    expect(bob.sent).toEqual([err("404", "bob", "#test", "Cannot send to channel")]);
    expect(alice.sent).toEqual([]);
  });

  it("replies 404 under +m without voice, delivers with +v and +o", () => {
    const { add, join, privmsg, channels } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    const carol = add("3", "carol");
    join(alice, "#test");
    join(bob, "#test");
    join(carol, "#test");
    const ch = channels.get("#test");
    if (ch === undefined) throw new Error("channel missing");
    ch.modes.moderated = true;
    for (const c of [alice, bob, carol]) c.sent.length = 0;

    privmsg(bob, "#test", "muted");
    expect(bob.sent).toEqual([err("404", "bob", "#test", "Cannot send to channel")]);
    expect(alice.sent).toEqual([]);

    const bobMembership = ch.members.get("2");
    if (bobMembership === undefined) throw new Error("bob missing");
    bobMembership.voice = true;
    privmsg(bob, "#test", "voiced");
    expect(alice.sent.map((m) => m.params[1])).toEqual(["voiced"]);

    privmsg(alice, "#test", "op speaks");
    expect(carol.sent.map((m) => m.params[1])).toEqual(["voiced", "op speaks"]);
  });

  it("replies 411 with no target", () => {
    const { add, privmsg } = setup();
    const alice = add("1", "alice");
    privmsg(alice);
    expect(alice.sent).toEqual([err("411", "alice", "No recipient given (PRIVMSG)")]);
  });

  it("replies 412 when text is absent or empty and does not deliver", () => {
    const { add, privmsg } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    privmsg(alice, "bob");
    privmsg(alice, "bob", "");
    expect(alice.sent).toEqual([
      err("412", "alice", "No text to send"),
      err("412", "alice", "No text to send"),
    ]);
    expect(bob.sent).toEqual([]);
  });

  it("sends 301 to the sender and still delivers to an away target", () => {
    const { add, privmsg } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    bob.away = "gone fishing";
    privmsg(alice, "bob", "ping");
    expect(alice.sent).toEqual([err("301", "alice", "bob", "gone fishing")]);
    expect(bob.sent).toEqual([
      { prefix: "alice!alice@host", command: "PRIVMSG", params: ["bob", "ping"] },
    ]);
  });
});
