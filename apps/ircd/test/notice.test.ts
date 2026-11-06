import { describe, expect, it } from "vitest";
import type { IrcMessage } from "@seance/irc-protocol";
import { ChannelRegistry } from "../src/channel-registry.js";
import type { Client } from "../src/client.js";
import { CommandRouter } from "../src/command-router.js";
import type { RouterContext } from "../src/command-router.js";
import { ConnectionManager } from "../src/connection-manager.js";
import { registerJoinHandler } from "../src/handlers/join.js";
import { registerNoticeHandler } from "../src/handlers/notice.js";

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
  registerNoticeHandler(router);
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
  const notice = (c: Client, ...params: string[]) =>
    router.dispatch(ctx, c, { command: "NOTICE", params });
  return { channels, add, join, notice };
}

describe("NOTICE handler", () => {
  it("relays to channel members except the sender", () => {
    const { add, join, notice } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    const carol = add("3", "carol");
    join(alice, "#test");
    join(bob, "#test");
    join(carol, "#other");
    for (const c of [alice, bob, carol]) c.sent.length = 0;
    notice(alice, "#TEST", "heads up");
    expect(bob.sent).toEqual([
      { prefix: "alice!alice@host", command: "NOTICE", params: ["#test", "heads up"] },
    ]);
    expect(alice.sent).toEqual([]);
    expect(carol.sent).toEqual([]);
  });

  it("relays a private notice to the target only", () => {
    const { add, notice } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "Bob");
    const carol = add("3", "carol");
    notice(alice, "bOb", "psst");
    expect(bob.sent).toEqual([
      { prefix: "alice!alice@host", command: "NOTICE", params: ["bOb", "psst"] },
    ]);
    expect(alice.sent).toEqual([]);
    expect(carol.sent).toEqual([]);
  });

  it("stays silent for an unknown nick", () => {
    const { add, notice } = setup();
    const alice = add("1", "alice");
    notice(alice, "ghost", "hi");
    expect(alice.sent).toEqual([]);
  });

  it("stays silent for an unknown channel", () => {
    const { add, notice } = setup();
    const alice = add("1", "alice");
    notice(alice, "#nope", "hi");
    expect(alice.sent).toEqual([]);
  });

  it("stays silent for a non-member and does not deliver", () => {
    const { add, join, notice } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    join(alice, "#test");
    alice.sent.length = 0;
    notice(bob, "#test", "hi");
    expect(bob.sent).toEqual([]);
    expect(alice.sent).toEqual([]);
  });

  it("stays silent under +m without voice and does not deliver", () => {
    const { add, join, notice, channels } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    join(alice, "#test");
    join(bob, "#test");
    const ch = channels.get("#test");
    if (ch === undefined) throw new Error("channel missing");
    ch.modes.moderated = true;
    alice.sent.length = 0;
    bob.sent.length = 0;
    notice(bob, "#test", "muted");
    expect(bob.sent).toEqual([]);
    expect(alice.sent).toEqual([]);
  });

  it("stays silent with no target", () => {
    const { add, notice } = setup();
    const alice = add("1", "alice");
    expect(notice(alice)).toBe("handled");
    expect(alice.sent).toEqual([]);
  });

  it("stays silent and does not deliver when text is absent or empty", () => {
    const { add, notice } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    notice(alice, "bob");
    notice(alice, "bob", "");
    expect(alice.sent).toEqual([]);
    expect(bob.sent).toEqual([]);
  });

  it("delivers to an away target without sending 301", () => {
    const { add, notice } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    bob.away = "gone fishing";
    notice(alice, "bob", "ping");
    expect(alice.sent).toEqual([]);
    expect(bob.sent).toEqual([
      { prefix: "alice!alice@host", command: "NOTICE", params: ["bob", "ping"] },
    ]);
  });
});
