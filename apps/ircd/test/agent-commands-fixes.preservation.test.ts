import { EventEmitter } from "node:events";
import { Numerics, serialize } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { ConnectionGate } from "../src/limits.js";
import { createServer } from "../src/server.js";
import { TcpTransport } from "../src/tcp-transport.js";
import { AWAYLEN } from "../src/text-limits.js";

// Feature: ircd-agent-commands-fixes, Property 2 (preservation): behaviour outside the bug
// conditions. Requirements 3.1 to 3.13. Observed on the unfixed code and asserted as-is:
// these tests must PASS before and after the fix.

const NOW = 1_700_000_000_000;

function setup(opts: { claims?: ReadonlySet<string> } = {}) {
  const error = vi.fn();
  const claims = opts.claims ?? new Set<string>();
  const server = createServer(
    loadConfig({}),
    { error },
    { now: () => NOW, inviteResolver: (target) => claims.has(target) },
  );
  const inbox = new Map<string, IrcMessage[]>();
  const events: Array<Record<string, unknown>> = [];
  server.events.subscribe("irc.invite", (e) => events.push({ ...e }));
  const create = (id: string, extra?: () => readonly string[]) => {
    const client = server.createVirtualClient(extra === undefined ? { id } : { id, whoisExtra: extra });
    const msgs: IrcMessage[] = [];
    inbox.set(id, msgs);
    client.onMessage((m) => msgs.push(m));
    return client;
  };
  const make = (id: string, nick: string, extra?: () => readonly string[]) => {
    const client = create(id, extra);
    client.dispatch({ command: "NICK", params: [nick] });
    // USER only accepts [A-Za-z0-9._~-]; nicks such as `A[B` need a safe username.
    const user = nick.replace(/[^A-Za-z0-9._~-]/g, "x");
    client.dispatch({ command: "USER", params: [user, "0", "*", nick] });
    return client;
  };
  const msgs = (id: string): IrcMessage[] => inbox.get(id) ?? [];
  const clear = (): void => {
    for (const m of inbox.values()) m.length = 0;
  };
  const codes = (id: string): string[] => msgs(id).map((m) => m.command);
  return { server, error, events, create, make, msgs, clear, codes, registry: server.ctx.channels };
}

const lines = (list: readonly IrcMessage[]): string[] => list.map((m) => serialize(m).trimEnd());

describe("Preservation: invited set (3.1 to 3.3)", () => {
  it("3.1 JOIN clears only the joiner's key", () => {
    const { make, registry } = setup();
    const alice = make("a", "alice");
    const bob = make("b", "bob");
    alice.dispatch({ command: "JOIN", params: ["#t"] });
    registry.invite("#t", "bob");
    registry.invite("#t", "carol");
    bob.dispatch({ command: "JOIN", params: ["#t"] });
    expect([...(registry.get("#t")?.invited ?? [])]).toEqual(["carol"]);
  });

  it("3.2 the last leaver discards the set and a recreated channel starts empty", () => {
    const { make, registry } = setup();
    const alice = make("a", "alice");
    alice.dispatch({ command: "JOIN", params: ["#t"] });
    registry.invite("#t", "bob");
    alice.dispatch({ command: "PART", params: ["#t"] });
    expect(registry.has("#t")).toBe(false);
    alice.dispatch({ command: "JOIN", params: ["#t"] });
    expect(registry.get("#t")?.invited.size).toBe(0);
  });

  it("3.3 case and rfc1459 variants share one entry, through the router", () => {
    const { make, registry, msgs } = setup();
    const alice = make("a", "alice");
    make("b", "A[B");
    alice.dispatch({ command: "JOIN", params: ["#t"] });
    alice.dispatch({ command: "INVITE", params: ["A[B", "#t"] });
    alice.dispatch({ command: "INVITE", params: ["a{b", "#t"] });
    alice.dispatch({ command: "INVITE", params: ["A{B", "#t"] });
    expect(lines(msgs("a")).filter((l) => / 4\d\d /.test(l))).toEqual([]);
    expect([...(registry.get("#t")?.invited ?? [])]).toEqual(["a{b"]);
  });
});

describe("Preservation: INVITE (3.4, 3.5, 3.9)", () => {
  it("3.4 a resolver claim replies 341, publishes the event, sends no INVITE, and the entry stays until join", () => {
    const { make, msgs, clear, events, registry, codes } = setup({ claims: new Set(["Ghost"]) });
    const alice = make("a", "alice");
    const carol = make("c", "carol");
    alice.dispatch({ command: "JOIN", params: ["#t"] });
    clear();
    alice.dispatch({ command: "INVITE", params: ["Ghost", "#t"] });
    expect(lines(msgs("a"))).toEqual([":seance.local 341 alice Ghost #t"]);
    expect(codes("c")).toEqual([]); // nobody receives an INVITE
    expect(events).toEqual([{ channel: "#t", inviter: "alice", target: "Ghost", ts: NOW }].map((e) => expect.objectContaining(e)));
    expect(registry.isInvited("#t", "ghost")).toBe(true);
    carol.dispatch({ command: "JOIN", params: ["#t"] });
    expect(registry.isInvited("#t", "ghost")).toBe(true); // other joins do not clear it
    const ghost = make("g", "Ghost");
    ghost.dispatch({ command: "JOIN", params: ["#t"] });
    expect(registry.isInvited("#t", "ghost")).toBe(false);
  });

  it("3.5 each rejection sends exactly one error, no 301, no event, no record", () => {
    const { make, msgs, clear, events, registry } = setup();
    const alice = make("a", "alice");
    const bob = make("b", "bob");
    const eve = make("e", "eve");
    const dan = make("d", "dan");
    dan.setAway("brb");
    alice.dispatch({ command: "JOIN", params: ["#t"] });
    bob.dispatch({ command: "JOIN", params: ["#t"] });
    const cases: ReadonlyArray<readonly [string, () => void, string]> = [
      ["403", () => alice.dispatch({ command: "INVITE", params: ["dan", "#nope"] }), Numerics.ERR_NOSUCHCHANNEL],
      ["442", () => eve.dispatch({ command: "INVITE", params: ["dan", "#t"] }), Numerics.ERR_NOTONCHANNEL],
      ["482", () => bob.dispatch({ command: "INVITE", params: ["dan", "#t"] }), Numerics.ERR_CHANOPRIVSNEEDED],
      ["401", () => alice.dispatch({ command: "INVITE", params: ["nobody", "#t"] }), Numerics.ERR_NOSUCHNICK],
      ["443", () => alice.dispatch({ command: "INVITE", params: ["bob", "#t"] }), Numerics.ERR_USERONCHANNEL],
    ];
    const senders = ["a", "e", "b", "a", "a"];
    cases.forEach(([label, act, code], i) => {
      clear();
      act();
      const sender = senders[i] ?? "a";
      expect(msgs(sender).map((m) => m.command), label).toEqual([code]);
      expect(msgs("d"), label).toEqual([]);
    });
    expect(events).toEqual([]);
    expect(registry.get("#t")?.invited.size).toBe(0);
  });

  it("3.9 a non-away target gets 341 and INVITE; the old event fields keep their values", () => {
    const { make, msgs, clear, events } = setup();
    const alice = make("a", "alice");
    make("b", "bob");
    alice.dispatch({ command: "JOIN", params: ["#t"] });
    clear();
    alice.dispatch({ command: "INVITE", params: ["BOB", "#t"] });
    expect(lines(msgs("a"))).toEqual([":seance.local 341 alice bob #t"]);
    expect(lines(msgs("b"))).toEqual([":alice!alice@seance.local INVITE bob #t"]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ channel: "#t", inviter: "alice", target: "bob", ts: NOW });
  });
});

describe("Preservation: WHOIS (3.6, 3.7)", () => {
  it("3.6 up to 10 valid lines give 320 in order between 312 and 301/317, extra called once", () => {
    const extra = vi.fn(() => ["model: sonnet", "tools: fs, git", "credits: 3"]);
    const { make, msgs, clear } = setup();
    const alice = make("a", "alice");
    const bob = make("b", "bob", extra);
    bob.setAway("brb");
    clear();
    alice.dispatch({ command: "WHOIS", params: ["bob"] });
    const cmds = msgs("a").map((m) => m.command);
    expect(cmds).toEqual([
      Numerics.RPL_WHOISUSER,
      Numerics.RPL_WHOISSERVER,
      Numerics.RPL_WHOISSPECIAL,
      Numerics.RPL_WHOISSPECIAL,
      Numerics.RPL_WHOISSPECIAL,
      Numerics.RPL_AWAY,
      Numerics.RPL_WHOISIDLE,
      Numerics.RPL_ENDOFWHOIS,
    ]);
    expect(msgs("a").filter((m) => m.command === Numerics.RPL_WHOISSPECIAL).map((m) => m.params)).toEqual([
      ["alice", "bob", "model: sonnet"],
      ["alice", "bob", "tools: fs, git"],
      ["alice", "bob", "credits: 3"],
    ]);
    expect(extra).toHaveBeenCalledTimes(1);
  });

  it("3.7 an empty array gives no 320 and a target without whoisExtra the same replies", () => {
    const { make, msgs, clear } = setup();
    const alice = make("a", "alice");
    make("b", "bob", () => []);
    make("c", "carol");
    clear();
    alice.dispatch({ command: "WHOIS", params: ["bob"] });
    alice.dispatch({ command: "WHOIS", params: ["carol"] });
    const cmds = msgs("a").map((m) => m.command);
    expect(cmds).not.toContain(Numerics.RPL_WHOISSPECIAL);
    expect(cmds.filter((c) => c === Numerics.RPL_ENDOFWHOIS)).toHaveLength(2);
  });

  it("3.7 an unknown nick gives 401 then 318, and no nick gives 431 without 318", () => {
    const { make, msgs, clear } = setup();
    const alice = make("a", "alice");
    clear();
    alice.dispatch({ command: "WHOIS", params: ["ghost"] });
    expect(lines(msgs("a"))).toEqual([
      ":seance.local 401 alice ghost :No such nick/channel",
      ":seance.local 318 alice ghost :End of /WHOIS list",
    ]);
    clear();
    alice.dispatch({ command: "WHOIS", params: [] });
    expect(lines(msgs("a"))).toEqual([":seance.local 431 alice :No nickname given"]);
  });
});

describe("Preservation: AWAY and messages (3.8, 3.10)", () => {
  it("3.8 real text is stored clamped at a code point boundary and replies 306", () => {
    const { make, msgs, clear } = setup();
    const alice = make("a", "alice");
    clear();
    alice.dispatch({ command: "AWAY", params: ["gone fishing"] });
    expect(alice.away).toBe("gone fishing");
    expect(lines(msgs("a"))).toEqual([":seance.local 306 alice :You have been marked as being away"]);
    const long = "é".repeat(150); // 300 bytes
    alice.dispatch({ command: "AWAY", params: [long] });
    expect(alice.away).toBe("é".repeat(AWAYLEN / 2));
    expect(Buffer.byteLength(alice.away ?? "", "utf8")).toBe(AWAYLEN);
  });

  it("3.8 bare AWAY replies 305 and clears; an unregistered client gets 451 and no change", () => {
    const { make, create, msgs, clear } = setup();
    const alice = make("a", "alice");
    alice.dispatch({ command: "AWAY", params: ["x"] });
    clear();
    alice.dispatch({ command: "AWAY", params: [] });
    expect(lines(msgs("a"))).toEqual([":seance.local 305 alice :You are no longer marked as being away"]);
    expect(alice.away).toBeUndefined();
    const anon = create("u");
    anon.dispatch({ command: "AWAY", params: ["hello"] });
    expect(msgs("u").map((m) => m.command)).toEqual([Numerics.ERR_NOTREGISTERED]);
    expect(anon.away).toBeUndefined();
  });

  it("3.10 PRIVMSG to an away nick gives one 301; NOTICE gives none", () => {
    const { make, msgs, clear } = setup();
    const alice = make("a", "alice");
    const bob = make("b", "bob");
    bob.setAway("brb");
    clear();
    alice.dispatch({ command: "PRIVMSG", params: ["bob", "hi"] });
    expect(lines(msgs("a"))).toEqual([":seance.local 301 alice bob brb"]);
    clear();
    alice.dispatch({ command: "NOTICE", params: ["bob", "psst"] });
    expect(msgs("a")).toEqual([]);
  });
});

describe("Preservation: golden lines (3.11)", () => {
  it("3.11 001 to 005, 306, 305 and relayed PRIVMSG/NOTICE prefixes are byte-identical", () => {
    const { make, msgs, clear } = setup();
    const alice = make("a", "alice");
    const welcome = lines(msgs("a")).slice(0, 5);
    expect(welcome[0]).toBe(":seance.local 001 alice :Welcome to the Séance IRC network, alice");
    expect(welcome[1]).toBe(":seance.local 002 alice :Your host is seance.local, running version seance-ircd-0.1");
    expect(welcome[2]).toMatch(/^:seance\.local 003 alice :This server was created \d{4}-\d\d-\d\dT[\d:.]+Z$/);
    // web-client-pixel-match R12.7 intentionally widened the channel modes of 004 to mntov.
    expect(welcome[3]).toBe(":seance.local 004 alice seance.local seance-ircd-0.1 o mntov");
    expect(welcome[4]).toBe(
      ":seance.local 005 alice CASEMAPPING=rfc1459 CHANTYPES=# NICKLEN=30 TOPICLEN=300 KICKLEN=300 AWAYLEN=200 PREFIX=(ov)@+ :are supported by this server",
    );
    const bob = make("b", "bob");
    alice.dispatch({ command: "JOIN", params: ["#t"] });
    bob.dispatch({ command: "JOIN", params: ["#t"] });
    clear();
    alice.dispatch({ command: "AWAY", params: ["gone"] });
    alice.dispatch({ command: "AWAY", params: [] });
    expect(lines(msgs("a"))).toEqual([
      ":seance.local 306 alice :You have been marked as being away",
      ":seance.local 305 alice :You are no longer marked as being away",
    ]);
    clear();
    alice.dispatch({ command: "PRIVMSG", params: ["bob", "hi"] });
    alice.dispatch({ command: "NOTICE", params: ["bob", "yo"] });
    alice.dispatch({ command: "PRIVMSG", params: ["#t", "chan"] });
    expect(lines(msgs("b"))).toEqual([
      ":alice!alice@seance.local PRIVMSG bob hi",
      ":alice!alice@seance.local NOTICE bob yo",
      ":alice!alice@seance.local PRIVMSG #t chan",
    ]);
  });
});

describe("Preservation: socket errors (3.12)", () => {
  it("3.12 an ETIMEDOUT error logs at error, destroys the socket and the slot is freed on close", () => {
    const { server, error } = setup();
    const gate = new ConnectionGate(1);
    const transport = new TcpTransport(server.ctx, server.router, { gate });
    const fake = Object.assign(new EventEmitter(), {
      remoteAddress: "127.0.0.1",
      destroyed: false,
      writableLength: 0,
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(() => {
        fake.destroyed = true;
      }),
    });
    (transport as unknown as { accept(socket: unknown): void }).accept(fake);
    expect(gate.count).toBe(1);
    fake.emit("error", Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT" }));
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[0]).toMatchObject({ clientId: expect.any(String) });
    expect(String(error.mock.calls[0]?.[1])).toContain("read ETIMEDOUT");
    expect(fake.destroy).toHaveBeenCalled();
    fake.emit("close");
    expect(gate.count).toBe(0);
    expect(gate.tryAcquire()).toBe(true);
  });
});

describe("Preservation: NICK (3.13)", () => {
  it("3.13 a non-invited client's NICK change is announced once to itself and to channel peers", () => {
    const { make, msgs, clear, registry } = setup();
    const alice = make("a", "alice");
    const bob = make("b", "bob");
    alice.dispatch({ command: "JOIN", params: ["#t"] });
    bob.dispatch({ command: "JOIN", params: ["#t"] });
    clear();
    bob.dispatch({ command: "NICK", params: ["robert"] });
    expect(lines(msgs("b"))).toEqual([":bob!bob@seance.local NICK robert"]);
    expect(lines(msgs("a"))).toEqual([":bob!bob@seance.local NICK robert"]);
    expect(registry.get("#t")?.invited.size).toBe(0);
  });
});
