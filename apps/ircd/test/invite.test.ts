import { Numerics, parse } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import type { InviteResolver } from "../src/command-router.js";
import type { IrcInviteEvent } from "../src/event-bus.js";
import { createServer } from "../src/server.js";
import type { VirtualClient } from "../src/virtual-client.js";

// Feature: ircd-agent-commands, Requirements 5.1-5.13, 6.1-6.8

const NOW_MS = 1_700_000_123_456;

function setup(inviteResolver?: InviteResolver) {
  const error = vi.fn();
  const server = createServer(loadConfig({}), { error }, {
    now: () => NOW_MS,
    ...(inviteResolver !== undefined ? { inviteResolver } : {}),
  });
  const events: IrcInviteEvent[] = [];
  server.events.subscribe("irc.invite", (e) => events.push(e));
  const inbox = new Map<string, IrcMessage[]>();

  const connect = (id: string): VirtualClient => {
    const c = server.createVirtualClient({ id });
    const msgs: IrcMessage[] = [];
    inbox.set(id, msgs);
    c.onMessage((m) => msgs.push(m));
    return c;
  };
  const make = (id: string, nick: string): VirtualClient => {
    const c = connect(id);
    c.dispatch({ command: "NICK", params: [nick] });
    c.dispatch({ command: "USER", params: ["user", "0", "*", `Real ${nick}`] });
    return c;
  };
  const send = (c: VirtualClient, line: string): void => {
    const m = parse(line);
    if (!("command" in m)) throw new Error(`bad line ${line}`);
    c.dispatch(m);
  };
  const msgs = (id: string): IrcMessage[] => inbox.get(id) ?? [];
  const clearAll = (): void => {
    for (const m of inbox.values()) m.length = 0;
  };
  return { server, error, events, connect, make, send, msgs, clearAll };
}

describe("INVITE success path (Req 5.1-5.3)", () => {
  it("replies 341, forwards INVITE with inviter prefix, publishes one event, records invite", () => {
    const s = setup();
    const op = s.make("o", "Op");
    s.make("t", "tina");
    s.send(op, "JOIN #Room");
    s.clearAll();

    s.send(op, "INVITE tina #room");

    const opOut = s.msgs("o");
    expect(opOut).toHaveLength(1);
    expect(opOut[0]?.command).toBe(Numerics.RPL_INVITING);
    expect(opOut[0]?.params).toEqual(["Op", "tina", "#Room"]);

    const tOut = s.msgs("t");
    expect(tOut).toHaveLength(1);
    expect(tOut[0]?.command).toBe("INVITE");
    expect(tOut[0]?.prefix).toBe(`Op!user@${s.server.ctx.serverName}`);
    expect(tOut[0]?.params).toEqual(["tina", "#Room"]);

    expect(s.events).toEqual([{ channel: "#Room", inviter: "Op", target: "tina", ts: NOW_MS }]);
    expect(s.server.ctx.channels.isInvited("#Room", "tina")).toBe(true);
  });
});

describe("INVITE rejections (Req 5.4-5.11)", () => {
  type Case = {
    name: string;
    code: string;
    /** Prepare state and return the actor id and the INVITE line to send. */
    prepare: (s: ReturnType<typeof setup>) => { actor: VirtualClient; id: string; line: string };
  };
  const cases: Case[] = [
    {
      name: "461 too few params",
      code: Numerics.ERR_NEEDMOREPARAMS,
      prepare: (s) => ({ actor: s.make("o", "Op"), id: "o", line: "INVITE tina" }),
    },
    {
      name: "403 no such channel",
      code: Numerics.ERR_NOSUCHCHANNEL,
      prepare: (s) => {
        s.make("t", "tina");
        return { actor: s.make("o", "Op"), id: "o", line: "INVITE tina #a" };
      },
    },
    {
      name: "442 inviter not on channel",
      code: Numerics.ERR_NOTONCHANNEL,
      prepare: (s) => {
        s.make("t", "tina");
        s.send(s.make("x", "Xan"), "JOIN #a");
        return { actor: s.make("o", "Op"), id: "o", line: "INVITE tina #a" };
      },
    },
    {
      name: "482 inviter not operator",
      code: Numerics.ERR_CHANOPRIVSNEEDED,
      prepare: (s) => {
        s.make("t", "tina");
        s.send(s.make("x", "Xan"), "JOIN #a");
        const op = s.make("o", "Op");
        s.send(op, "JOIN #a");
        return { actor: op, id: "o", line: "INVITE tina #a" };
      },
    },
    {
      name: "401 unknown target",
      code: Numerics.ERR_NOSUCHNICK,
      prepare: (s) => {
        const op = s.make("o", "Op");
        s.send(op, "JOIN #a");
        return { actor: op, id: "o", line: "INVITE ghost #a" };
      },
    },
    {
      name: "443 target already on channel",
      code: Numerics.ERR_USERONCHANNEL,
      prepare: (s) => {
        const op = s.make("o", "Op");
        s.send(op, "JOIN #a");
        s.send(s.make("t", "tina"), "JOIN #a");
        return { actor: op, id: "o", line: "INVITE tina #a" };
      },
    },
    {
      name: "451 unregistered",
      code: Numerics.ERR_NOTREGISTERED,
      prepare: (s) => {
        s.make("t", "tina");
        return { actor: s.connect("u"), id: "u", line: "INVITE tina #a" };
      },
    },
  ];

  for (const c of cases) {
    it(`${c.name}: one reply, no side effects`, () => {
      const s = setup();
      const bystander = s.make("b", "bob");
      void bystander;
      const { actor, id, line } = c.prepare(s);
      s.clearAll();
      s.send(actor, line);
      expect(s.msgs(id)).toHaveLength(1);
      expect(s.msgs(id)[0]?.command).toBe(c.code);
      for (const other of ["t", "b", "x"]) expect(s.msgs(other)).toHaveLength(0);
      expect(s.events).toHaveLength(0);
      expect(s.server.ctx.channels.isInvited("#a", "tina")).toBe(false);
      expect(s.server.ctx.channels.isInvited("#a", "ghost")).toBe(false);
      expect(s.error).not.toHaveBeenCalled();
    });
  }

  it("reflects the channel/nick as sent (Req 5.5, 5.8)", () => {
    const s = setup();
    const op = s.make("o", "Op");
    s.send(op, "JOIN #a");
    s.clearAll();
    s.send(op, "INVITE GhOsT #a");
    expect(s.msgs("o")[0]?.params[1]).toBe("GhOsT");
    s.clearAll();
    s.send(op, "INVITE ghost #NoPe");
    expect(s.msgs("o")[0]?.params[1]).toBe("#NoPe");
  });

  it("stops at the first failing check when several fail (Req 5.12)", () => {
    const s = setup();
    const op = s.make("o", "Op");
    const other = s.make("x", "Xan");

    // 461 beats 403
    s.clearAll();
    s.send(op, "INVITE ghost");
    expect(s.msgs("o").map((m) => m.command)).toEqual([Numerics.ERR_NEEDMOREPARAMS]);

    // 403 beats 401 (unknown channel and unknown nick)
    s.clearAll();
    s.send(op, "INVITE ghost #none");
    expect(s.msgs("o").map((m) => m.command)).toEqual([Numerics.ERR_NOSUCHCHANNEL]);

    // 442 beats 482 and 401 (not a member, hence not op, unknown nick)
    s.send(other, "JOIN #a");
    s.clearAll();
    s.send(op, "INVITE ghost #a");
    expect(s.msgs("o").map((m) => m.command)).toEqual([Numerics.ERR_NOTONCHANNEL]);

    // 482 beats 401 (member without op, unknown nick)
    s.send(op, "JOIN #a");
    s.clearAll();
    s.send(op, "INVITE ghost #a");
    expect(s.msgs("o").map((m) => m.command)).toEqual([Numerics.ERR_CHANOPRIVSNEEDED]);
    expect(s.events).toHaveLength(0);
  });

  it("unregistered client gets only 451 even for a bad channel (Req 5.10)", () => {
    const s = setup();
    const u = s.connect("u");
    s.send(u, "INVITE a");
    expect(s.msgs("u").map((m) => m.command)).toEqual([Numerics.ERR_NOTREGISTERED]);
  });
});

describe("INVITE rfc1459 case-mapping (Req 5.13)", () => {
  it("matches target nick and channel case-insensitively with []\\~ mapping", () => {
    const s = setup();
    const op = s.make("o", "Op");
    s.make("t", "T[ina]");
    s.send(op, "JOIN #Foo[1]");
    s.clearAll();
    s.send(op, "INVITE t{INA} #FOO{1}");
    expect(s.msgs("o")[0]?.command).toBe(Numerics.RPL_INVITING);
    expect(s.msgs("o")[0]?.params).toEqual(["Op", "T[ina]", "#Foo[1]"]);
    expect(s.msgs("t")[0]?.params).toEqual(["T[ina]", "#Foo[1]"]);
    expect(s.server.ctx.channels.isInvited("#foo[1]", "t{ina}")).toBe(true);
  });

  it("detects an existing member through case-mapping (443)", () => {
    const s = setup();
    const op = s.make("o", "Op");
    s.send(op, "JOIN #a");
    s.send(s.make("t", "Tina"), "JOIN #a");
    s.clearAll();
    s.send(op, "INVITE TINA #A");
    expect(s.msgs("o").map((m) => m.command)).toEqual([Numerics.ERR_USERONCHANNEL]);
  });
});

describe("InviteResolver (Req 6)", () => {
  function opInChannel(s: ReturnType<typeof setup>): VirtualClient {
    const op = s.make("o", "Op");
    s.send(op, "JOIN #Room");
    s.clearAll();
    return op;
  }

  it("claim: 341, event, record, nothing sent to any client", () => {
    const s = setup(() => true);
    const bystander = s.make("b", "bob");
    const op = opInChannel(s);
    s.send(op, "INVITE coder #room");
    expect(s.msgs("o").map((m) => m.command)).toEqual([Numerics.RPL_INVITING]);
    expect(s.msgs("o")[0]?.params).toEqual(["Op", "coder", "#Room"]);
    expect(s.msgs("b")).toHaveLength(0);
    void bystander;
    expect(s.events).toEqual([{ channel: "#Room", inviter: "Op", target: "coder", ts: NOW_MS }]);
    expect(s.server.ctx.channels.isInvited("#Room", "coder")).toBe(true);
  });

  it("no claim: 401, no event, no record", () => {
    const s = setup(() => false);
    const op = opInChannel(s);
    s.send(op, "INVITE coder #room");
    expect(s.msgs("o").map((m) => m.command)).toEqual([Numerics.ERR_NOSUCHNICK]);
    expect(s.events).toHaveLength(0);
    expect(s.server.ctx.channels.isInvited("#Room", "coder")).toBe(false);
  });

  it("throw: logged with command and client id, 401, no event, no record, server keeps serving", () => {
    const s = setup(() => {
      throw new Error("boom");
    });
    const op = opInChannel(s);
    s.send(op, "INVITE coder #room");
    expect(s.msgs("o").map((m) => m.command)).toEqual([Numerics.ERR_NOSUCHNICK]);
    expect(s.events).toHaveLength(0);
    expect(s.server.ctx.channels.isInvited("#Room", "coder")).toBe(false);
    expect(s.error).toHaveBeenCalledTimes(1);
    const [fields] = s.error.mock.calls[0] as [Record<string, unknown>];
    expect(fields).toMatchObject({ command: "INVITE", clientId: "o" });

    s.clearAll();
    s.send(op, "PING x");
    expect(s.msgs("o").length).toBeGreaterThan(0);
  });

  it("thenable: treated as no claim, rejection does not become unhandled", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const s = setup((() => Promise.reject(new Error("late"))) as unknown as InviteResolver);
      const op = opInChannel(s);
      s.send(op, "INVITE coder #room");
      expect(s.msgs("o").map((m) => m.command)).toEqual([Numerics.ERR_NOSUCHNICK]);
      expect(s.events).toHaveLength(0);
      expect(s.server.ctx.channels.isInvited("#Room", "coder")).toBe(false);
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("is not asked for registered targets", () => {
    const resolver = vi.fn(() => true);
    const s = setup(resolver);
    s.make("t", "tina");
    const op = opInChannel(s);
    s.send(op, "INVITE tina #room");
    expect(resolver).not.toHaveBeenCalled();
    expect(s.msgs("t")[0]?.command).toBe("INVITE");
  });

  it("is not asked for invalid nicks", () => {
    const resolver = vi.fn(() => true);
    const s = setup(resolver);
    const op = opInChannel(s);
    s.send(op, "INVITE 1bad #room");
    expect(resolver).not.toHaveBeenCalled();
    expect(s.msgs("o").map((m) => m.command)).toEqual([Numerics.ERR_NOSUCHNICK]);
  });

  it("is not asked when an earlier check fails", () => {
    const resolver = vi.fn(() => true);
    const s = setup(resolver);
    const op = s.make("o", "Op");
    s.send(op, "INVITE coder #none");
    expect(resolver).not.toHaveBeenCalled();
  });

  it("receives exactly three plain strings", () => {
    const resolver = vi.fn((_t: string, _c: string, _i: string) => true);
    const s = setup(resolver);
    const op = opInChannel(s);
    s.send(op, "INVITE coder #room");
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver.mock.calls[0]).toEqual(["coder", "#Room", "Op"]);
    for (const a of resolver.mock.calls[0] ?? []) expect(typeof a).toBe("string");
  });

  it("no resolver configured: 401, no event, no record", () => {
    const s = setup();
    const op = opInChannel(s);
    s.send(op, "INVITE coder #room");
    expect(s.msgs("o").map((m) => m.command)).toEqual([Numerics.ERR_NOSUCHNICK]);
    expect(s.events).toHaveLength(0);
    expect(s.server.ctx.channels.isInvited("#Room", "coder")).toBe(false);
  });
});
