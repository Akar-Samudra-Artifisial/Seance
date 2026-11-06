import { describe, expect, it } from "vitest";
import type { IrcMessage } from "@seance/irc-protocol";
import { ChannelRegistry } from "../src/channel-registry.js";
import type { Client } from "../src/client.js";
import { CommandRouter } from "../src/command-router.js";
import type { RouterContext } from "../src/command-router.js";
import { ConnectionManager } from "../src/connection-manager.js";
import { EventBus } from "../src/event-bus.js";
import type { IrcKickEvent } from "../src/event-bus.js";
import { registerJoinHandler } from "../src/handlers/join.js";
import { registerKickHandler } from "../src/handlers/kick.js";

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
  registerKickHandler(router);
  const events = new EventBus();
  const kicks: IrcKickEvent[] = [];
  events.subscribe("irc.kick", (e) => kicks.push(e));
  const ctx: RouterContext = {
    connections,
    channels,
    serverName: "irc.test",
    logger: { error: () => {} },
    events,
  };
  const add = (id: string, nick: string): TestClient => {
    const c = makeClient(id, nick);
    connections.add(c);
    return c;
  };
  const join = (c: Client, arg: string) =>
    router.dispatch(ctx, c, { command: "JOIN", params: [arg] });
  const kick = (c: Client, ...params: string[]) =>
    router.dispatch(ctx, c, { command: "KICK", params });
  return { channels, kicks, add, join, kick };
}

const numerics = (c: TestClient): string[] => c.sent.map((m) => m.command);

describe("KICK handler", () => {
  it("broadcasts to all members incl. target, removes target, defaults reason to kicker nick, publishes event", () => {
    const { add, join, kick, channels, kicks } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    const carol = add("3", "carol");
    join(alice, "#t");
    join(bob, "#t");
    join(carol, "#t");
    for (const c of [alice, bob, carol]) c.sent.length = 0;

    kick(alice, "#t", "bob");

    for (const c of [alice, bob, carol]) {
      expect(c.sent).toEqual([
        { prefix: "alice!alice@host", command: "KICK", params: ["#t", "bob", "alice"] },
      ]);
    }
    expect(channels.isMember("#t", bob.id)).toBe(false);
    expect(kicks).toEqual([{ channel: "#t", by: "alice", target: "bob", reason: "alice" }]);
  });

  it("uses the supplied reason", () => {
    const { add, join, kick, kicks } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    join(alice, "#t");
    join(bob, "#t");
    kick(alice, "#t", "bob", "spam");
    expect(kicks[0]?.reason).toBe("spam");
  });

  it("removes the channel when the op kicks the last other member and itself", () => {
    const { add, join, kick, channels } = setup();
    const alice = add("1", "alice");
    join(alice, "#t");
    kick(alice, "#t", "alice");
    expect(channels.has("#t")).toBe(false);
  });

  it("replies 403, 442, 482, 441, 461 in precedence without mutating", () => {
    const { add, join, kick, channels, kicks } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    const dave = add("4", "dave");
    join(alice, "#t");
    join(bob, "#t");
    for (const c of [alice, bob, dave]) c.sent.length = 0;

    kick(dave, "#nope", "bob");
    kick(dave, "#t", "bob");
    kick(bob, "#t", "alice");
    kick(alice, "#t", "dave");
    kick(alice, "#t");

    expect(numerics(dave)).toEqual(["403", "442"]);
    expect(numerics(bob)).toEqual(["482"]);
    expect(numerics(alice)).toEqual(["441", "461"]);
    expect(channels.get("#t")?.members.size).toBe(2);
    expect(kicks).toEqual([]);
  });
});
