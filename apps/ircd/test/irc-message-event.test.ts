import { Numerics } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import type { IrcMessageEvent } from "../src/event-bus.js";
import { createServer } from "../src/server.js";

// Req 5.1, 5.14 (agent-runner task 21.2): deliverMessage publishes `irc.message`
// exactly once per delivered channel PRIVMSG/NOTICE and nothing otherwise.

function setup() {
  const server = createServer(loadConfig({}), { error: vi.fn() }, { now: () => 1_700_000_000_000 });
  const events: IrcMessageEvent[] = [];
  server.events.subscribe("irc.message", (e) => events.push(e));
  const make = (id: string, nick: string) => {
    const client = server.createVirtualClient({ id });
    const msgs: IrcMessage[] = [];
    client.onMessage((m) => msgs.push(m));
    client.dispatch({ command: "NICK", params: [nick] });
    client.dispatch({ command: "USER", params: [nick, "0", "*", nick] });
    return { client, msgs };
  };
  return { events, make };
}

describe("irc.message event", () => {
  it.each(["PRIVMSG", "NOTICE"] as const)("publishes one event for a channel %s", (command) => {
    const { events, make } = setup();
    const alice = make("a", "alice");
    const bob = make("b", "bob");
    alice.client.dispatch({ command: "JOIN", params: ["#Room"] });
    bob.client.dispatch({ command: "JOIN", params: ["#room"] });

    alice.client.dispatch({ command, params: ["#room", "hello 👻"] });

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.channel).toBe("#Room");
    expect(event?.from).toBe("alice");
    expect(event?.message.command).toBe(command);
    expect(event?.message.params).toEqual(["#Room", "hello 👻"]);
    expect(event?.message.prefix).toContain("alice");
  });

  it.each(["PRIVMSG", "NOTICE"] as const)("publishes nothing for a %s to a missing channel", (command) => {
    const { events, make } = setup();
    const alice = make("a", "alice");
    alice.client.dispatch({ command, params: ["#nowhere", "hi"] });
    expect(events).toEqual([]);
  });

  it.each(["PRIVMSG", "NOTICE"] as const)("publishes nothing for a %s from a non-member (404)", (command) => {
    const { events, make } = setup();
    const alice = make("a", "alice");
    const eve = make("e", "eve");
    alice.client.dispatch({ command: "JOIN", params: ["#room"] });
    alice.client.dispatch({ command: "MODE", params: ["#room", "+n"] });
    eve.msgs.length = 0;

    eve.client.dispatch({ command, params: ["#room", "hi"] });

    expect(events).toEqual([]);
    if (command === "PRIVMSG") {
      expect(eve.msgs.map((m) => m.command)).toContain(Numerics.ERR_CANNOTSENDTOCHAN);
    }
  });

  it.each(["PRIVMSG", "NOTICE"] as const)("publishes nothing for a %s rejected by +m", (command) => {
    const { events, make } = setup();
    const alice = make("a", "alice");
    const bob = make("b", "bob");
    alice.client.dispatch({ command: "JOIN", params: ["#room"] });
    bob.client.dispatch({ command: "JOIN", params: ["#room"] });
    alice.client.dispatch({ command: "MODE", params: ["#room", "+m"] });
    bob.msgs.length = 0;

    bob.client.dispatch({ command, params: ["#room", "muted"] });

    expect(events).toEqual([]);
    if (command === "PRIVMSG") {
      expect(bob.msgs.map((m) => m.command)).toContain(Numerics.ERR_CANNOTSENDTOCHAN);
    }
    // An operator may still speak under +m and is published.
    alice.client.dispatch({ command, params: ["#room", "allowed"] });
    expect(events).toHaveLength(1);
    expect(events[0]?.from).toBe("alice");
  });

  it.each(["PRIVMSG", "NOTICE"] as const)("publishes nothing for a private %s", (command) => {
    const { events, make } = setup();
    const alice = make("a", "alice");
    const bob = make("b", "bob");
    alice.client.dispatch({ command, params: ["bob", "psst"] });
    alice.client.dispatch({ command, params: ["ghost", "psst"] });
    expect(bob.msgs.some((m) => m.command === command)).toBe(true);
    expect(events).toEqual([]);
  });
});
