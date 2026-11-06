import { describe, expect, it } from "vitest";
import type { IrcMessage } from "@seance/irc-protocol";
import { ChannelRegistry } from "../src/channel-registry.js";
import type { Client } from "../src/client.js";
import { CommandRouter } from "../src/command-router.js";
import type { RouterContext } from "../src/command-router.js";
import { ConnectionManager } from "../src/connection-manager.js";
import { EventBus } from "../src/event-bus.js";
import type { IrcModeEvent } from "../src/event-bus.js";
import { registerJoinHandler } from "../src/handlers/join.js";
import { registerModeHandler } from "../src/handlers/mode.js";

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
  const connections = new ConnectionManager(channels.memberIdsLookup, { serverName: "irc.test" });
  const events = new EventBus();
  const emitted: IrcModeEvent[] = [];
  events.subscribe("irc.mode", (e) => emitted.push(e));
  const router = new CommandRouter();
  registerJoinHandler(router);
  registerModeHandler(router);
  const ctx: RouterContext = {
    connections,
    channels,
    serverName: "irc.test",
    logger: { error: () => {} },
    events,
  };
  const alice = makeClient("1", "alice");
  const bob = makeClient("2", "bob");
  connections.add(alice);
  connections.add(bob);
  router.dispatch(ctx, alice, { command: "JOIN", params: ["#t"] });
  router.dispatch(ctx, bob, { command: "JOIN", params: ["#t"] });
  alice.sent.length = 0;
  bob.sent.length = 0;
  const mode = (c: Client, ...params: string[]) =>
    router.dispatch(ctx, c, { command: "MODE", params });
  return { alice, bob, channels, emitted, mode };
}

describe("MODE handler", () => {
  it("+o broadcasts from the operator and sets the flag", () => {
    const { alice, bob, channels, emitted, mode } = setup();
    mode(alice, "#t", "+o", "bob");
    const msg = { prefix: "alice!alice@host", command: "MODE", params: ["#t", "+o", "bob"] };
    expect(alice.sent).toEqual([msg]);
    expect(bob.sent).toEqual([msg]);
    expect(channels.isOp("#t", "2")).toBe(true);
    expect(emitted).toEqual([{ channel: "#t", by: "alice", mode: "o", adding: true, target: "bob" }]);
  });

  it("-v clears voice; +m / -m toggle moderation", () => {
    const { alice, bob, channels, mode } = setup();
    mode(alice, "#t", "+v", "bob");
    expect(channels.get("#t")?.members.get("2")?.voice).toBe(true);
    mode(alice, "#t", "-v", "bob");
    expect(channels.get("#t")?.members.get("2")?.voice).toBe(false);
    bob.sent.length = 0;
    mode(alice, "#t", "+m");
    expect(bob.sent).toEqual([{ prefix: "alice!alice@host", command: "MODE", params: ["#t", "+m"] }]);
    expect(channels.get("#t")?.modes.moderated).toBe(true);
    mode(alice, "#t", "-m");
    expect(channels.get("#t")?.modes.moderated).toBe(false);
  });

  it("bare MODE replies 324", () => {
    const { bob, alice, mode } = setup();
    mode(alice, "#t", "+m");
    bob.sent.length = 0;
    mode(bob, "#t");
    expect(bob.sent).toEqual([
      { prefix: "irc.test", command: "324", params: ["bob", "#t", "+m"] },
    ]);
  });

  it("rejects with 403, 482, 461, 472, 441 and changes nothing", () => {
    const { alice, bob, channels, emitted, mode } = setup();
    mode(alice, "#nope", "+m");
    expect(alice.sent.at(-1)?.command).toBe("403");
    mode(bob, "#t", "+o", "bob");
    expect(bob.sent.at(-1)?.command).toBe("482");
    mode(alice, "#t", "+o");
    expect(alice.sent.at(-1)?.command).toBe("461");
    mode(alice, "#t", "+mx");
    expect(alice.sent.at(-1)?.command).toBe("472");
    mode(alice, "#t", "+mo", "ghost");
    expect(alice.sent.at(-1)?.command).toBe("441");
    expect(channels.get("#t")?.modes.moderated).toBe(false);
    expect(channels.isOp("#t", "2")).toBe(false);
    expect(emitted).toEqual([]);
    expect(bob.sent.filter((m) => m.command === "MODE")).toEqual([]);
  });
});
