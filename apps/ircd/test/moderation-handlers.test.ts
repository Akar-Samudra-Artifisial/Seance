import { describe, expect, it } from "vitest";
import type { IrcMessage } from "@seance/irc-protocol";
import { ChannelRegistry } from "../src/channel-registry.js";
import type { Client } from "../src/client.js";
import { CommandRouter } from "../src/command-router.js";
import type { RouterContext } from "../src/command-router.js";
import { ConnectionManager } from "../src/connection-manager.js";
import { EventBus } from "../src/event-bus.js";
import type { IrcKickEvent, IrcModeEvent } from "../src/event-bus.js";
import { registerJoinHandler } from "../src/handlers/join.js";
import { registerKickHandler } from "../src/handlers/kick.js";
import { registerModeHandler } from "../src/handlers/mode.js";
import { registerQuitHandler } from "../src/handlers/quit.js";

type TestClient = Client & { readonly sent: IrcMessage[]; closed: number };

function setup() {
  const channels = new ChannelRegistry();
  const connections = new ConnectionManager(channels.memberIdsLookup, { serverName: "irc.test" });
  const events = new EventBus();
  const modes: IrcModeEvent[] = [];
  const kicks: IrcKickEvent[] = [];
  events.subscribe("irc.mode", (e) => modes.push(e));
  events.subscribe("irc.kick", (e) => kicks.push(e));
  const router = new CommandRouter();
  registerJoinHandler(router);
  registerModeHandler(router);
  registerKickHandler(router);
  registerQuitHandler(router);
  const ctx: RouterContext = {
    connections,
    channels,
    serverName: "irc.test",
    logger: { error: () => {} },
    events,
  };
  const add = (id: string, nick: string): TestClient => {
    const sent: IrcMessage[] = [];
    const c: TestClient = {
      id,
      nick,
      user: nick,
      host: "host",
      registered: true,
      sent,
      closed: 0,
      send: (m) => {
        sent.push(m);
      },
      close: () => {
        c.closed += 1;
      },
    };
    connections.add(c);
    return c;
  };
  const run = (c: Client, command: string, ...params: string[]) =>
    router.dispatch(ctx, c, { command, params });
  const clear = (...cs: TestClient[]) => {
    for (const c of cs) c.sent.length = 0;
  };
  return { channels, connections, modes, kicks, add, run, clear };
}

describe("MODE handler (gaps)", () => {
  // web-client-pixel-match R12.5 changed this: one grouped MODE per command, listing only the
  // changes that altered state (`-m` on a channel without `+m` is dropped), events likewise.
  it("applies a multi-change string in order, one grouped broadcast, one event per effective change", () => {
    const { add, run, clear, channels, modes } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    run(alice, "JOIN", "#t");
    run(bob, "JOIN", "#t");
    clear(alice, bob);

    run(alice, "MODE", "#t", "+ov-m", "bob", "bob");

    const origin = "alice!alice@host";
    expect(bob.sent).toEqual([{ prefix: origin, command: "MODE", params: ["#t", "+ov", "bob", "bob"] }]);
    expect(alice.sent).toEqual(bob.sent);
    expect(channels.isOp("#t", "2")).toBe(true);
    expect(modes).toEqual([
      { channel: "#t", by: "alice", mode: "o", adding: true, target: "bob" },
      { channel: "#t", by: "alice", mode: "v", adding: true, target: "bob" },
    ]);
  });

  it("accepts +mnt as one command, one MODE line, and reports the flags in 324", () => {
    const { add, run, clear, channels, modes } = setup();
    const alice = add("1", "alice");
    run(alice, "JOIN", "#t");
    run(alice, "MODE", "#t", "-nt");
    clear(alice);
    modes.length = 0;

    run(alice, "MODE", "#t", "+mnt");
    expect(alice.sent).toEqual([{ prefix: "alice!alice@host", command: "MODE", params: ["#t", "+mnt"] }]);
    expect(channels.get("#t")?.modes).toEqual({ moderated: true, noExternal: true, topicLock: true });
    expect(modes).toEqual([{ channel: "#t", by: "alice", mode: "m", adding: true }]);

    clear(alice);
    run(alice, "MODE", "#t");
    expect(alice.sent).toEqual([{ prefix: "irc.test", command: "324", params: ["alice", "#t", "+mnt"] }]);
  });

  it("broadcasts nothing for a command that changes nothing", () => {
    const { add, run, clear } = setup();
    const alice = add("1", "alice");
    run(alice, "JOIN", "#t");
    clear(alice);
    run(alice, "MODE", "#t", "+nt");
    expect(alice.sent).toEqual([]);
  });

  it("-o removes operator status and publishes the event", () => {
    const { add, run, channels, modes } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    run(alice, "JOIN", "#t");
    run(bob, "JOIN", "#t");
    run(alice, "MODE", "#t", "+o", "bob");
    run(alice, "MODE", "#t", "-o", "bob");
    expect(channels.isOp("#t", "2")).toBe(false);
    expect(modes.at(-1)).toEqual({ channel: "#t", by: "alice", mode: "o", adding: false, target: "bob" });
  });

  it("resolves channel and nick case-insensitively and reports the stored nick", () => {
    const { add, run, clear, channels, modes } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "Bob");
    run(alice, "JOIN", "#T");
    run(bob, "JOIN", "#t");
    clear(alice, bob);
    run(alice, "MODE", "#t", "+v", "BOB");
    expect(channels.get("#t")?.members.get("2")?.voice).toBe(true);
    expect(bob.sent[0]?.params).toEqual(["#T", "+v", "Bob"]);
    expect(modes[0]?.target).toBe("Bob");
  });

  it("replies 324 with '+' when no mode is set", () => {
    const { add, run, clear } = setup();
    const alice = add("1", "alice");
    run(alice, "JOIN", "#t");
    clear(alice);
    run(alice, "MODE", "#t");
    // web-client-pixel-match R12.1: a new channel is `+nt`.
    expect(alice.sent).toEqual([{ prefix: "irc.test", command: "324", params: ["alice", "#t", "+nt"] }]);
  });

  it("a voiced non-op gets 482 and nothing changes", () => {
    const { add, run, clear, channels, modes } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    run(alice, "JOIN", "#t");
    run(bob, "JOIN", "#t");
    run(alice, "MODE", "#t", "+v", "bob");
    clear(alice, bob);
    modes.length = 0;
    run(bob, "MODE", "#t", "+m");
    expect(bob.sent.map((m) => m.command)).toEqual(["482"]);
    expect(alice.sent).toEqual([]);
    expect(channels.get("#t")?.modes.moderated).toBe(false);
    expect(modes).toEqual([]);
  });

  it("a rejected change later in the string leaves earlier changes unapplied", () => {
    const { add, run, clear, channels, modes } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    run(alice, "JOIN", "#t");
    run(bob, "JOIN", "#t");
    clear(alice, bob);
    run(alice, "MODE", "#t", "+ov", "bob", "ghost");
    expect(alice.sent.map((m) => m.command)).toEqual(["441"]);
    expect(bob.sent).toEqual([]);
    expect(channels.isOp("#t", "2")).toBe(false);
    expect(modes).toEqual([]);
  });

  it("MODE with no parameters replies 461", () => {
    const { add, run } = setup();
    const alice = add("1", "alice");
    run(alice, "MODE");
    expect(alice.sent.map((m) => m.command)).toEqual(["461"]);
  });
});

describe("KICK handler (gaps)", () => {
  it("an empty reason falls back to the kicker nick", () => {
    const { add, run, kicks } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    run(alice, "JOIN", "#t");
    run(bob, "JOIN", "#t");
    run(alice, "KICK", "#t", "bob", "");
    expect(kicks).toEqual([{ channel: "#t", by: "alice", target: "bob", reason: "alice" }]);
  });

  it("matches channel and target case-insensitively and keeps the channel for others", () => {
    const { add, run, clear, channels } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "Bob");
    run(alice, "JOIN", "#T");
    run(bob, "JOIN", "#t");
    clear(alice, bob);
    run(alice, "KICK", "#t", "BOB", "out");
    expect(bob.sent).toEqual([
      { prefix: "alice!alice@host", command: "KICK", params: ["#T", "Bob", "out"] },
    ]);
    expect(channels.has("#t")).toBe(true);
    expect(channels.isMember("#t", "2")).toBe(false);
  });

  it("a kicked user receives no further channel traffic and may rejoin", () => {
    const { add, run, clear, channels } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    run(alice, "JOIN", "#t");
    run(bob, "JOIN", "#t");
    run(alice, "KICK", "#t", "bob");
    clear(bob);
    run(alice, "MODE", "#t", "+m");
    expect(bob.sent).toEqual([]);
    run(bob, "JOIN", "#t");
    expect(channels.isMember("#t", "2")).toBe(true);
  });

  it("a voiced non-op gets 482 and the target stays", () => {
    const { add, run, channels, kicks } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    const carol = add("3", "carol");
    run(alice, "JOIN", "#t");
    run(bob, "JOIN", "#t");
    run(carol, "JOIN", "#t");
    run(alice, "MODE", "#t", "+v", "bob");
    bob.sent.length = 0;
    run(bob, "KICK", "#t", "carol");
    expect(bob.sent.map((m) => m.command)).toEqual(["482"]);
    expect(channels.isMember("#t", "3")).toBe(true);
    expect(kicks).toEqual([]);
  });

  it("441 for a target who is a known nick but in another channel", () => {
    const { add, run, clear, kicks } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    run(alice, "JOIN", "#t");
    run(bob, "JOIN", "#other");
    clear(alice, bob);
    run(alice, "KICK", "#t", "bob");
    expect(alice.sent).toEqual([
      { prefix: "irc.test", command: "441", params: ["alice", "bob", "#t", "They aren't on that channel"] },
    ]);
    expect(bob.sent).toEqual([]);
    expect(kicks).toEqual([]);
  });
});

describe("QUIT handler (gaps)", () => {
  it("notifies each peer once, skips users sharing no channel, and keeps shared channels alive", () => {
    const { add, run, clear, channels } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    const carol = add("3", "carol");
    const dave = add("4", "dave");
    run(alice, "JOIN", "#a,#b,#c");
    run(bob, "JOIN", "#a,#b,#c");
    run(carol, "JOIN", "#c");
    run(dave, "JOIN", "#d");
    clear(alice, bob, carol, dave);

    run(alice, "QUIT", "gone");

    const quit = { prefix: "alice!alice@host", command: "QUIT", params: ["gone"] };
    expect(bob.sent).toEqual([quit]);
    expect(carol.sent).toEqual([quit]);
    expect(dave.sent).toEqual([]);
    expect(alice.closed).toBe(1);
    expect(channels.has("#a")).toBe(true);
    expect(channels.channelsOf("1")).toEqual([]);
  });

  it("frees the nick for immediate reuse", () => {
    const { add, run, connections } = setup();
    const alice = add("1", "alice");
    run(alice, "QUIT");
    const again = add("9", "ALICE");
    expect(connections.getByNick("alice")?.id).toBe(again.id);
  });

  it("an unregistered client can QUIT and is closed", () => {
    const { run, connections } = setup();
    const sent: IrcMessage[] = [];
    let closed = 0;
    const guest: Client = {
      id: "7",
      nick: undefined,
      user: undefined,
      host: "host",
      registered: false,
      send: (m: IrcMessage) => {
        sent.push(m);
      },
      close: () => {
        closed += 1;
      },
    } as unknown as Client;
    connections.add(guest);
    run(guest, "QUIT");
    expect(closed).toBe(1);
    expect(connections.get("7")).toBeUndefined();
  });
});
