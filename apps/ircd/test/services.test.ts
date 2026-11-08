// runner-services Requirements 1 to 3 (ircd side): reserved nicks, Service_Notice delivery and the
// registration event.
import { Numerics, SERVICE_NICKS, serialize } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import type { VirtualClient } from "../src/virtual-client.js";

function setup() {
  const error = vi.fn();
  const server = createServer(loadConfig({ IRCD_SERVER_NAME: "seance.test" }), { error });
  const inbox = new Map<string, IrcMessage[]>();
  const messages: unknown[] = [];
  const registers: { nick: string; virtual: boolean }[] = [];
  server.events.subscribe("irc.message", (e) => messages.push(e));
  server.events.subscribe("irc.register", (e) => registers.push(e));
  let n = 0;
  const make = (nick: string): VirtualClient => {
    n += 1;
    const id = `c${String(n)}`;
    const client = server.createVirtualClient({ id });
    const box: IrcMessage[] = [];
    inbox.set(id, box);
    client.onMessage((m) => box.push(m));
    client.dispatch({ command: "NICK", params: [nick] });
    client.dispatch({ command: "USER", params: ["u", "0", "*", "Real"] });
    return client;
  };
  const box = (c: VirtualClient): IrcMessage[] => inbox.get(c.id) ?? [];
  const clear = (c: VirtualClient): void => {
    box(c).length = 0;
  };
  return { server, error, make, box, clear, messages, registers };
}

describe("reserved service nicks (Req 1.2, 1.3, 1.5)", () => {
  it.each(["ChanServ", "chanserv", "NICKSERV", "NickServ"])("refuses NICK %s with 432 and registers nobody", (nick) => {
    const t = setup();
    const c = t.make(nick);
    const reply = t.box(c).find((m) => m.command === Numerics.ERR_ERRONEUSNICKNAME);
    expect(reply?.params.slice(1)).toEqual([nick, "Nickname is reserved for network services"]);
    expect(c.registered).toBe(false);
    expect(t.server.ctx.connections.getByNick(nick)).toBeUndefined();
    expect(t.registers).toEqual([]);
  });

  it("refuses a nick change of a registered client and keeps the old nick", () => {
    const t = setup();
    const alice = t.make("alice");
    expect(alice.registered).toBe(true);
    t.clear(alice);
    alice.dispatch({ command: "NICK", params: ["NickServ"] });
    expect(t.box(alice).map((m) => m.command)).toEqual([Numerics.ERR_ERRONEUSNICKNAME]);
    expect(alice.nick).toBe("alice");
    expect(t.server.ctx.connections.getByNick("alice")).toBe(alice);
  });

  it("keeps the old 432 text for invalid syntax", () => {
    const t = setup();
    const c = t.make("1bad");
    expect(t.box(c).find((m) => m.command === Numerics.ERR_ERRONEUSNICKNAME)?.params[2]).toBe("Erroneous nickname");
  });

  it("answers WHOIS and PRIVMSG to a service with 401 like any unknown nick", () => {
    const t = setup();
    const alice = t.make("alice");
    t.clear(alice);
    alice.dispatch({ command: "WHOIS", params: ["ChanServ"] });
    alice.dispatch({ command: "PRIVMSG", params: ["NickServ", "help"] });
    expect(t.box(alice).filter((m) => m.command === Numerics.ERR_NOSUCHNICK)).toHaveLength(2);
  });

  it("P4 reserved nick never registers: any case variant keeps the old nick", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SERVICE_NICKS).chain((s) =>
          fc.array(fc.boolean(), { minLength: s.length, maxLength: s.length }).map((flags) =>
            [...s].map((ch, i) => (flags[i] === true ? ch.toUpperCase() : ch.toLowerCase())).join(""),
          ),
        ),
        (variant) => {
          const t = setup();
          const fresh = t.make(variant);
          expect(fresh.registered).toBe(false);
          const bob = t.make("bob");
          bob.dispatch({ command: "NICK", params: [variant] });
          expect(bob.nick).toBe("bob");
          expect(t.server.ctx.connections.getByNick(variant)).toBeUndefined();
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Service_Notice delivery (Req 2)", () => {
  it("sends one NOTICE with the service prefix to every channel member, and none as irc.message", () => {
    const t = setup();
    const alice = t.make("alice");
    const bob = t.make("bob");
    alice.dispatch({ command: "JOIN", params: ["#dev"] });
    bob.dispatch({ command: "JOIN", params: ["#dev"] });
    t.clear(alice);
    t.clear(bob);
    t.messages.length = 0;
    expect(t.server.services.notice("ChanServ", "#DEV", "worktree ready: workspaces/dev @ a1b2c3d")).toBe(true);
    const expected: IrcMessage = {
      prefix: "ChanServ!ChanServ@services.seance.test",
      command: "NOTICE",
      params: ["#dev", "worktree ready: workspaces/dev @ a1b2c3d"],
    };
    expect(t.box(alice)).toEqual([expected]);
    expect(t.box(bob)).toEqual([expected]);
    expect(t.messages).toEqual([]);
  });

  it("bypasses +m and +n: a service is not a member", () => {
    const t = setup();
    const alice = t.make("alice");
    alice.dispatch({ command: "JOIN", params: ["#m"] });
    alice.dispatch({ command: "MODE", params: ["#m", "+mn"] });
    t.clear(alice);
    expect(t.server.services.notice("ChanServ", "#m", "hi")).toBe(true);
    expect(t.box(alice).map((m) => m.command)).toEqual(["NOTICE"]);
  });

  it("sends to a registered nick and returns false for unknown targets", () => {
    const t = setup();
    const alice = t.make("alice");
    t.clear(alice);
    expect(t.server.services.notice("NickServ", "ALICE", "agents online: coder (idle)")).toBe(true);
    expect(t.box(alice)).toEqual([
      { prefix: "NickServ!NickServ@services.seance.test", command: "NOTICE", params: ["alice", "agents online: coder (idle)"] },
    ]);
    expect(t.server.services.notice("NickServ", "nobody", "x")).toBe(false);
    expect(t.server.services.notice("ChanServ", "#nowhere", "x")).toBe(false);
    const unregistered = t.make("ChanServ"); // refused, stays unregistered
    expect(t.server.services.notice("NickServ", unregistered.nick ?? "ChanServ", "x")).toBe(false);
  });

  it("removes CR, LF and NUL and cuts an overlong text so the line fits 512 bytes", () => {
    const t = setup();
    const alice = t.make("alice");
    alice.dispatch({ command: "JOIN", params: ["#long"] });
    t.clear(alice);
    expect(t.server.services.notice("ChanServ", "#long", `a\r\nb\0c ${"é".repeat(600)}`)).toBe(true);
    const msg = t.box(alice)[0];
    expect(msg?.params[1]?.startsWith("abc ")).toBe(true);
    expect(Buffer.byteLength(serialize(msg as IrcMessage), "utf8")).toBeLessThanOrEqual(512);
    expect(msg?.params[1]).not.toMatch(/[\r\n\0]/);
  });
});

describe("irc.register (Req 3)", () => {
  it("publishes once per registration, last, with only nick and virtual", () => {
    const t = setup();
    t.make("alice");
    t.make("bob");
    expect(t.registers).toEqual([
      { nick: "alice", virtual: true },
      { nick: "bob", virtual: true },
    ]);
    // A nick change after registration is not a new registration.
    const alice = t.server.ctx.connections.getByNick("alice") as VirtualClient;
    alice.dispatch({ command: "NICK", params: ["alice2"] });
    expect(t.registers).toHaveLength(2);
  });

  it("publishes nothing for a registration refused with 464", () => {
    const error = vi.fn();
    const server = createServer(loadConfig({ IRCD_SERVER_PASSWORD: "s3cret" }), { error });
    const registers: unknown[] = [];
    server.events.subscribe("irc.register", (e) => registers.push(e));
    const c = server.createVirtualClient({ id: "x" });
    c.dispatch({ command: "NICK", params: ["eve"] });
    c.dispatch({ command: "USER", params: ["u", "0", "*", "Eve"] });
    expect(registers).toEqual([]);
  });
});
