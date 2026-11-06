import { describe, expect, it, vi } from "vitest";
import { Numerics, serialize } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import type { VirtualClient } from "../src/virtual-client.js";

// Feature: ircd-agent-commands, Requirement 9: reflected input in error numerics is clamped.

const SERVER = "seance.local";
const bytes = (m: IrcMessage): number => Buffer.byteLength(serialize(m), "utf8");

/** Unclamped wire length of `:<server> <code> alice <reflected...> :<text>\r\n`. */
function unclampedLength(code: string, reflected: readonly string[], text: string): number {
  return Buffer.byteLength(`:${SERVER} ${code} alice ${reflected.join(" ")} :${text}\r\n`, "utf8");
}

function world() {
  const logger = { error: vi.fn() };
  const server = createServer(loadConfig({}), logger);
  const inbox = new Map<string, IrcMessage[]>();
  const make = (id: string, nick: string): VirtualClient => {
    const client = server.createVirtualClient({ id });
    const msgs: IrcMessage[] = [];
    inbox.set(id, msgs);
    client.onMessage((m) => msgs.push(m));
    client.dispatch({ command: "NICK", params: [nick] });
    client.dispatch({ command: "USER", params: [nick, "0", "*", nick] });
    return client;
  };
  const alice = make("a", "alice");
  const bob = make("b", "bob");
  /** Messages alice receives while `run` executes. */
  const capture = (run: () => void): IrcMessage[] => {
    const box = inbox.get("a") ?? [];
    const before = box.length;
    run();
    return box.slice(before);
  };
  const expectHealthy = (): void => {
    expect(logger.error).not.toHaveBeenCalled();
    expect(server.ctx.connections.get("a")).toBeDefined();
    expect((inbox.get("a") ?? []).some((m) => m.command === "ERROR")).toBe(false);
  };
  return { server, alice, bob, capture, expectHealthy };
}

/** 480 UTF-8 bytes of 2-byte and 4-byte characters; the dispatched line still fits in 512. */
const OVERSIZED = [
  ["2-byte characters", "é".repeat(240)],
  ["4-byte characters", "😀".repeat(120)],
] as const;

describe.each(OVERSIZED)("oversized reflected input (%s)", (_label, big) => {
  const channel = `#${big}`;
  const check = (
    replies: readonly IrcMessage[],
    code: string,
    index: number,
    input: string,
    text: string,
  ): void => {
    expect(replies).toHaveLength(1);
    const reply = replies[0] as IrcMessage;
    expect(reply.command).toBe(code);
    expect(unclampedLength(code, [input], text)).toBeGreaterThan(512); // really oversized
    expect(bytes(reply)).toBeLessThanOrEqual(512);
    const shown = reply.params[index] ?? "";
    expect(shown.length).toBeGreaterThan(0);
    expect(shown).not.toContain("\uFFFD");
    expect(input.startsWith(shown)).toBe(true); // a code point prefix
    expect(shown.length).toBeLessThan(input.length);
    expect(reply.params.at(-1)).toBe(text);
  };

  it("JOIN: 403 for an invalid oversized channel", () => {
    const { alice, capture, expectHealthy } = world();
    const replies = capture(() => alice.dispatch({ command: "JOIN", params: [channel] }));
    check(replies, Numerics.ERR_NOSUCHCHANNEL, 1, channel, "No such channel");
    expectHealthy();
  });

  it.each(["PART", "TOPIC", "MODE", "KICK"])("%s: 403 for an oversized unknown channel", (command) => {
    const { alice, capture, expectHealthy } = world();
    const params = command === "KICK" ? [channel, "bob"] : [channel];
    const replies = capture(() => alice.dispatch({ command, params }));
    check(replies, Numerics.ERR_NOSUCHCHANNEL, 1, channel, "No such channel");
    expectHealthy();
  });

  it("PRIVMSG: 403 for an oversized unknown channel and 401 for an oversized unknown nick", () => {
    const { alice, capture, expectHealthy } = world();
    check(
      capture(() => alice.dispatch({ command: "PRIVMSG", params: [channel, "hi"] })),
      Numerics.ERR_NOSUCHCHANNEL,
      1,
      channel,
      "No such channel",
    );
    check(
      capture(() => alice.dispatch({ command: "PRIVMSG", params: [big, "hi"] })),
      Numerics.ERR_NOSUCHNICK,
      1,
      big,
      "No such nick/channel",
    );
    expectHealthy();
  });

  it("NOTICE: never replies with an error, even for oversized targets", () => {
    const { alice, capture, expectHealthy } = world();
    const replies = capture(() => {
      alice.dispatch({ command: "NOTICE", params: [channel, "hi"] });
      alice.dispatch({ command: "NOTICE", params: [big, "hi"] });
    });
    expect(replies).toEqual([]);
    expectHealthy();
  });

  it("KICK: 441 for an oversized target nick", () => {
    const { alice, capture, expectHealthy } = world();
    alice.dispatch({ command: "JOIN", params: ["#t"] });
    const replies = capture(() => alice.dispatch({ command: "KICK", params: ["#t", big] }));
    expect(replies).toHaveLength(1);
    const reply = replies[0] as IrcMessage;
    expect(reply.command).toBe(Numerics.ERR_USERNOTINCHANNEL);
    expect(unclampedLength(Numerics.ERR_USERNOTINCHANNEL, [big, "#t"], "They aren't on that channel")).toBeGreaterThan(512);
    expect(bytes(reply)).toBeLessThanOrEqual(512);
    const shown = reply.params[1] ?? "";
    expect(shown.length).toBeGreaterThan(0);
    expect(shown).not.toContain("\uFFFD");
    expect(big.startsWith(shown)).toBe(true);
    expect(reply.params[2]).toBe("#t");
    expectHealthy();
  });

  it("MODE: 441 for an oversized +o target nick", () => {
    const { alice, capture, expectHealthy } = world();
    alice.dispatch({ command: "JOIN", params: ["#t"] });
    const replies = capture(() => alice.dispatch({ command: "MODE", params: ["#t", "+o", big] }));
    expect(replies).toHaveLength(1);
    const reply = replies[0] as IrcMessage;
    expect(reply.command).toBe(Numerics.ERR_USERNOTINCHANNEL);
    expect(bytes(reply)).toBeLessThanOrEqual(512);
    const shown = reply.params[1] ?? "";
    expect(shown).not.toContain("\uFFFD");
    expect(big.startsWith(shown)).toBe(true);
    expect(shown.length).toBeLessThan(big.length);
    expectHealthy();
  });
});

describe("maximum-length existing channel names (442, 482)", () => {
  // Channels are capped by name length, so these replies fit; they must stay within 512 bytes.
  const longName = `#${"😀".repeat(24)}`;

  it("PART, TOPIC, MODE, KICK: 442 when the sender is not a member", () => {
    const { bob, alice, capture, expectHealthy } = world();
    bob.dispatch({ command: "JOIN", params: [longName] });
    for (const [command, params] of [
      ["PART", [longName]],
      ["TOPIC", [longName]],
      ["MODE", [longName]],
      ["KICK", [longName, "bob"]],
    ] as const) {
      const replies = capture(() => alice.dispatch({ command, params: [...params] }));
      expect(replies).toHaveLength(1);
      expect(replies[0]?.command).toBe(Numerics.ERR_NOTONCHANNEL);
      expect(bytes(replies[0] as IrcMessage)).toBeLessThanOrEqual(512);
    }
    expectHealthy();
  });

  it("TOPIC, MODE, KICK: 482 when the sender is not an operator", () => {
    const { bob, alice, capture, expectHealthy } = world();
    bob.dispatch({ command: "JOIN", params: [longName] });
    alice.dispatch({ command: "JOIN", params: [longName] });
    for (const [command, params] of [
      ["TOPIC", [longName, "new topic"]],
      ["MODE", [longName, "+v", "alice"]],
      ["KICK", [longName, "bob"]],
    ] as const) {
      const replies = capture(() => alice.dispatch({ command, params: [...params] }));
      expect(replies).toHaveLength(1);
      expect(replies[0]?.command).toBe(Numerics.ERR_CHANOPRIVSNEEDED);
      expect(bytes(replies[0] as IrcMessage)).toBeLessThanOrEqual(512);
    }
    expectHealthy();
  });
});

describe("short reflected input is unchanged", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly setup?: (w: ReturnType<typeof world>) => void;
    readonly command: string;
    readonly params: readonly string[];
    readonly expected: (nick: string) => readonly string[];
    readonly code: string;
  }> = [
    { name: "JOIN 403", command: "JOIN", params: ["nochan"], code: Numerics.ERR_NOSUCHCHANNEL, expected: () => ["alice", "nochan", "No such channel"] },
    { name: "PART 403", command: "PART", params: ["#nochan"], code: Numerics.ERR_NOSUCHCHANNEL, expected: () => ["alice", "#nochan", "No such channel"] },
    { name: "TOPIC 403", command: "TOPIC", params: ["#nochan"], code: Numerics.ERR_NOSUCHCHANNEL, expected: () => ["alice", "#nochan", "No such channel"] },
    { name: "MODE 403", command: "MODE", params: ["#nochan"], code: Numerics.ERR_NOSUCHCHANNEL, expected: () => ["alice", "#nochan", "No such channel"] },
    { name: "KICK 403", command: "KICK", params: ["#nochan", "bob"], code: Numerics.ERR_NOSUCHCHANNEL, expected: () => ["alice", "#nochan", "No such channel"] },
    { name: "PRIVMSG 403", command: "PRIVMSG", params: ["#nochan", "hi"], code: Numerics.ERR_NOSUCHCHANNEL, expected: () => ["alice", "#nochan", "No such channel"] },
    { name: "PRIVMSG 401", command: "PRIVMSG", params: ["ghost", "hi"], code: Numerics.ERR_NOSUCHNICK, expected: () => ["alice", "ghost", "No such nick/channel"] },
    {
      name: "PART 442",
      setup: (w) => w.bob.dispatch({ command: "JOIN", params: ["#t"] }),
      command: "PART",
      params: ["#t"],
      code: Numerics.ERR_NOTONCHANNEL,
      expected: () => ["alice", "#t", "You're not on that channel"],
    },
    {
      name: "TOPIC 482",
      setup: (w) => {
        w.bob.dispatch({ command: "JOIN", params: ["#t"] });
        w.alice.dispatch({ command: "JOIN", params: ["#t"] });
      },
      command: "TOPIC",
      params: ["#t", "x"],
      code: Numerics.ERR_CHANOPRIVSNEEDED,
      expected: () => ["alice", "#t", "You're not channel operator"],
    },
    {
      name: "KICK 441",
      setup: (w) => w.alice.dispatch({ command: "JOIN", params: ["#t"] }),
      command: "KICK",
      params: ["#t", "ghost"],
      code: Numerics.ERR_USERNOTINCHANNEL,
      expected: () => ["alice", "ghost", "#t", "They aren't on that channel"],
    },
    {
      name: "MODE 441",
      setup: (w) => w.alice.dispatch({ command: "JOIN", params: ["#t"] }),
      command: "MODE",
      params: ["#t", "+o", "ghost"],
      code: Numerics.ERR_USERNOTINCHANNEL,
      expected: () => ["alice", "ghost", "#t", "They aren't on that channel"],
    },
  ];

  it.each(cases)("$name is byte-identical to the unclamped reply", (c) => {
    const w = world();
    c.setup?.(w);
    const replies = w.capture(() => w.alice.dispatch({ command: c.command, params: [...c.params] }));
    expect(replies).toHaveLength(1);
    expect(replies[0]).toEqual({ prefix: SERVER, command: c.code, params: c.expected("alice") });
    expect(serialize(replies[0] as IrcMessage)).toBe(
      `:${SERVER} ${c.code} ${c.expected("alice").slice(0, -1).join(" ")} :${c.expected("alice").at(-1)}\r\n`,
    );
    w.expectHealthy();
  });

  it("NOTICE to an unknown target stays silent", () => {
    const w = world();
    expect(w.capture(() => w.alice.dispatch({ command: "NOTICE", params: ["ghost", "hi"] }))).toEqual([]);
    w.expectHealthy();
  });
});
