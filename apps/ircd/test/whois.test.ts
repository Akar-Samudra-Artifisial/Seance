import { Numerics, parse } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { ConnectionSession } from "../src/network-client.js";
import type { Wire } from "../src/network-client.js";
import { createServer } from "../src/server.js";
import type { VirtualClient } from "../src/virtual-client.js";

// Feature: ircd-agent-commands, Requirements 2.1-2.11, 2.14, 3.2-3.7, 4.7

const START_MS = 1_700_000_000_000;

function setup() {
  let nowMs = START_MS;
  const error = vi.fn();
  const server = createServer(loadConfig({}), { error }, { now: () => nowMs });
  const inbox = new Map<string, IrcMessage[]>();

  const make = (id: string, nick: string, whoisExtra?: () => readonly string[]): VirtualClient => {
    const client = server.createVirtualClient(
      whoisExtra === undefined ? { id } : { id, whoisExtra },
    );
    const msgs: IrcMessage[] = [];
    inbox.set(id, msgs);
    client.onMessage((m) => msgs.push(m));
    client.dispatch({ command: "NICK", params: [nick] });
    client.dispatch({ command: "USER", params: ["user", "0", "*", `Real ${nick}`] });
    return client;
  };

  const makeNetwork = (id: string, nick: string): ConnectionSession => {
    const wire: Wire = {
      write: () => {},
      end: () => {},
      destroy: () => {},
      bufferedBytes: () => 0,
      isDestroyed: () => false,
    };
    const session = new ConnectionSession(server.ctx, server.router, id, "10.1.2.3", wire);
    session.receive(`NICK ${nick}\r\n`);
    session.receive(`USER ${nick} 0 * :Net ${nick}\r\n`);
    return session;
  };

  const msgs = (id: string): IrcMessage[] => inbox.get(id) ?? [];
  const clear = (id: string): void => {
    msgs(id).length = 0;
  };
  const send = (c: VirtualClient, line: string): void => {
    const m = parse(line);
    if (!("command" in m)) throw new Error(`bad line ${line}`);
    c.dispatch(m);
  };
  const whois = (c: VirtualClient, id: string, line: string): IrcMessage[] => {
    clear(id);
    send(c, line);
    return [...msgs(id)];
  };
  return {
    server,
    error,
    make,
    makeNetwork,
    msgs,
    clear,
    send,
    whois,
    advance: (s: number) => {
      nowMs += s * 1000;
    },
    nowSec: () => Math.floor(nowMs / 1000),
    setNow: (ms: number) => {
      nowMs = ms;
    },
  };
}

const codes = (ms: readonly IrcMessage[]): string[] => ms.map((m) => m.command);

describe("WHOIS reply order and shape (Req 2.1-2.3, 3.2)", () => {
  it("sends 311, 319, 312, 320, 301, 317, 318 in order", () => {
    const s = setup();
    const req = s.make("r", "req");
    const t = s.make("t", "tina", () => ["model: x", "credits: 3"]);
    s.send(t, "JOIN #a");
    s.send(t, "AWAY :brb");
    const out = s.whois(req, "r", "WHOIS tina");
    expect(codes(out)).toEqual([
      Numerics.RPL_WHOISUSER,
      Numerics.RPL_WHOISCHANNELS,
      Numerics.RPL_WHOISSERVER,
      Numerics.RPL_WHOISSPECIAL,
      Numerics.RPL_WHOISSPECIAL,
      Numerics.RPL_AWAY,
      Numerics.RPL_WHOISIDLE,
      Numerics.RPL_ENDOFWHOIS,
    ]);
    const sn = s.server.ctx.serverName;
    expect(out.every((m) => m.prefix === sn)).toBe(true);
    expect(out[0]?.params).toEqual(["req", "tina", "user", sn, "*", "Real tina"]);
    expect(out[1]?.params).toEqual(["req", "tina", "@#a"]);
    expect(out[2]?.params.slice(0, 3)).toEqual(["req", "tina", sn]);
    expect(out[3]?.params).toEqual(["req", "tina", "model: x"]);
    expect(out[4]?.params).toEqual(["req", "tina", "credits: 3"]);
    expect(out[5]?.params).toEqual(["req", "tina", "brb"]);
    expect(out[7]?.params[1]).toBe("tina");
  });

  it("omits 319 when the target is in no channel and 301 when not away", () => {
    const s = setup();
    const req = s.make("r", "req");
    s.make("t", "tina");
    const out = s.whois(req, "r", "WHOIS tina");
    expect(codes(out)).toEqual([
      Numerics.RPL_WHOISUSER,
      Numerics.RPL_WHOISSERVER,
      Numerics.RPL_WHOISIDLE,
      Numerics.RPL_ENDOFWHOIS,
    ]);
  });

  it("accepts WHOIS <server> <nick>", () => {
    const s = setup();
    const req = s.make("r", "req");
    s.make("t", "tina");
    const out = s.whois(req, "r", `WHOIS ${s.server.ctx.serverName} tina`);
    expect(out[0]?.command).toBe(Numerics.RPL_WHOISUSER);
    expect(out[0]?.params[1]).toBe("tina");
    expect(out.at(-1)?.command).toBe(Numerics.RPL_ENDOFWHOIS);
  });

  it("answers only the first nick of a comma list", () => {
    const s = setup();
    const req = s.make("r", "req");
    s.make("t", "tina");
    s.make("u", "uma");
    const out = s.whois(req, "r", "WHOIS tina,uma");
    expect(out.filter((m) => m.command === Numerics.RPL_WHOISUSER)).toHaveLength(1);
    expect(out.filter((m) => m.command === Numerics.RPL_ENDOFWHOIS)).toHaveLength(1);
    expect(out[0]?.params[1]).toBe("tina");
  });

  it("matches nicks with rfc1459 case-mapping", () => {
    const s = setup();
    const req = s.make("r", "req");
    s.make("t", "Ti[na]");
    const out = s.whois(req, "r", "WHOIS ti{na}");
    expect(out[0]?.command).toBe(Numerics.RPL_WHOISUSER);
    expect(out[0]?.params[1]).toBe("Ti[na]");
  });
});

describe("WHOIS errors (Req 2.6-2.10)", () => {
  it("sends 401 then 318 for an unknown nick", () => {
    const s = setup();
    const req = s.make("r", "req");
    const out = s.whois(req, "r", "WHOIS ghost");
    expect(codes(out)).toEqual([Numerics.ERR_NOSUCHNICK, Numerics.RPL_ENDOFWHOIS]);
    expect(out[0]?.params[0]).toBe("req");
    expect(out[0]?.params[1]).toBe("ghost");
    expect(out[1]?.params[1]).toBe("ghost");
  });

  it("sends 401 + 318 for an unregistered target", () => {
    const s = setup();
    const req = s.make("r", "req");
    const half = s.server.createVirtualClient({ id: "h" });
    half.dispatch({ command: "NICK", params: ["half"] });
    const out = s.whois(req, "r", "WHOIS half");
    expect(codes(out)).toEqual([Numerics.ERR_NOSUCHNICK, Numerics.RPL_ENDOFWHOIS]);
  });

  it("sends 431 and no 318 when no nick is given", () => {
    const s = setup();
    const req = s.make("r", "req");
    const out = s.whois(req, "r", "WHOIS");
    expect(codes(out)).toEqual([Numerics.ERR_NONICKNAMEGIVEN]);
  });

  it("sends 451 to an unregistered requester", () => {
    const s = setup();
    s.make("t", "tina");
    const c = s.server.createVirtualClient({ id: "u" });
    const msgs: IrcMessage[] = [];
    c.onMessage((m) => msgs.push(m));
    c.dispatch({ command: "WHOIS", params: ["tina"] });
    expect(codes(msgs)).toEqual([Numerics.ERR_NOTREGISTERED]);
  });
});

describe("WHOIS 319 (Req 2.4, 2.5)", () => {
  it("uses @, + and no prefix for op, voice and plain members", () => {
    const s = setup();
    const req = s.make("r", "req");
    const t = s.make("t", "tina");
    s.send(t, "JOIN #ops"); // creator is op
    const o = s.make("o", "olga");
    s.send(o, "JOIN #voiced");
    s.send(t, "JOIN #voiced");
    s.send(o, "JOIN #plain");
    s.send(o, "MODE #voiced +v tina");
    s.send(t, "JOIN #plain");
    const out = s.whois(req, "r", "WHOIS tina");
    const entries = out
      .filter((m) => m.command === Numerics.RPL_WHOISCHANNELS)
      .flatMap((m) => (m.params[2] ?? "").split(" "));
    expect([...entries].sort()).toEqual(["#plain", "+#voiced", "@#ops"]);
  });

  it("splits many channels over several 319 lines under 512 bytes, without splitting entries", () => {
    const s = setup();
    const req = s.make("r", "req");
    const t = s.make("t", "tina");
    const names = Array.from({ length: 60 }, (_, i) => `#chan-${String(i).padStart(2, "0")}-${"é".repeat(15)}`);
    for (const n of names) s.send(t, `JOIN ${n}`);
    const out = s.whois(req, "r", "WHOIS tina");
    const lines = out.filter((m) => m.command === Numerics.RPL_WHOISCHANNELS);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) {
      expect(Buffer.byteLength(`:${l.prefix} ${l.command} ${l.params.join(" ")}\r\n`)).toBeLessThanOrEqual(512);
    }
    const entries = lines.flatMap((m) => (m.params[2] ?? "").split(" "));
    expect(entries.sort()).toEqual(names.map((n) => `@${n}`).sort());
    // 319 lines are contiguous, between 311 and 312.
    expect(codes(out).slice(0, 1)).toEqual([Numerics.RPL_WHOISUSER]);
    expect(codes(out)[lines.length + 1]).toBe(Numerics.RPL_WHOISSERVER);
  });
});

describe("WHOIS 320 and whoisExtra (Req 3.2-3.7)", () => {
  it("sends no 320 for an empty list or a client without whoisExtra", () => {
    const s = setup();
    const req = s.make("r", "req");
    s.make("t", "tina", () => []);
    s.make("n", "nora");
    for (const nick of ["tina", "nora"]) {
      expect(codes(s.whois(req, "r", `WHOIS ${nick}`))).not.toContain(Numerics.RPL_WHOISSPECIAL);
    }
  });

  it("calls whoisExtra exactly once per WHOIS and strips control characters", () => {
    const s = setup();
    const req = s.make("r", "req");
    const extra = vi.fn(() => ["a\r\nb\0c"]);
    s.make("t", "tina", extra);
    const out = s.whois(req, "r", "WHOIS tina");
    expect(extra).toHaveBeenCalledTimes(1);
    const lines = out.filter((m) => m.command === Numerics.RPL_WHOISSPECIAL);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.params[2]).toBe("a  b c");
    s.whois(req, "r", "WHOIS tina");
    expect(extra).toHaveBeenCalledTimes(2);
  });

  it("clamps an oversized 320 line to 512 bytes", () => {
    const s = setup();
    const req = s.make("r", "req");
    s.make("t", "tina", () => ["€".repeat(500)]);
    const m = s.whois(req, "r", "WHOIS tina").find((x) => x.command === Numerics.RPL_WHOISSPECIAL);
    const text = m?.params[2] ?? "";
    expect(text.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(`:${m?.prefix} 320 req tina :${text}\r\n`)).toBeLessThanOrEqual(512);
    expect(text).not.toContain("\uFFFD");
  });

  it("logs a throwing whoisExtra, skips 320 and still sends the rest including 318", () => {
    const s = setup();
    const req = s.make("r", "req");
    s.make("t", "tina", () => {
      throw new Error("boom");
    });
    const out = s.whois(req, "r", "WHOIS tina");
    expect(codes(out)).toEqual([
      Numerics.RPL_WHOISUSER,
      Numerics.RPL_WHOISSERVER,
      Numerics.RPL_WHOISIDLE,
      Numerics.RPL_ENDOFWHOIS,
    ]);
    expect(s.error).toHaveBeenCalledTimes(1);
    const [ctx, text] = s.error.mock.calls[0] as [Record<string, unknown>, string];
    expect(ctx).toMatchObject({ command: "WHOIS", clientId: "r", targetId: "t" });
    expect(ctx["error"]).toBeInstanceOf(Error);
    expect(text).toContain("boom");
  });
});

describe("WHOIS 317 with a fake clock (Req 4.7)", () => {
  it("reports idle seconds and sign-on time", () => {
    const s = setup();
    const req = s.make("r", "req");
    const t = s.make("t", "tina");
    s.make("u", "uma");
    const signon = s.nowSec();
    s.advance(40);
    s.send(t, "PRIVMSG uma :hi");
    s.advance(25);
    const m = s.whois(req, "r", "WHOIS tina").find((x) => x.command === Numerics.RPL_WHOISIDLE);
    expect(m?.params.slice(0, 4)).toEqual(["req", "tina", "25", String(signon)]);
    expect(m?.params[4]).toBe("seconds idle, signon time");
  });

  it("reports idle 0 right after registration", () => {
    const s = setup();
    const req = s.make("r", "req");
    s.make("t", "tina");
    const m = s.whois(req, "r", "WHOIS tina").find((x) => x.command === Numerics.RPL_WHOISIDLE);
    expect(m?.params[2]).toBe("0");
  });

  it("never reports a negative idle when the clock goes backwards", () => {
    const s = setup();
    const req = s.make("r", "req");
    s.make("t", "tina");
    s.advance(100);
    s.setNow(START_MS - 500_000);
    const m = s.whois(req, "r", "WHOIS tina").find((x) => x.command === Numerics.RPL_WHOISIDLE);
    expect(m?.params[2]).toBe("0");
    expect(m?.params[3]).toBe(String(Math.floor(START_MS / 1000)));
  });
});

describe("WHOIS 301 placement (Req 2.1)", () => {
  it("comes after 320 and before 317", () => {
    const s = setup();
    const req = s.make("r", "req");
    const t = s.make("t", "tina", () => ["x"]);
    s.send(t, "AWAY :gone");
    const c = codes(s.whois(req, "r", "WHOIS tina"));
    const i301 = c.indexOf(Numerics.RPL_AWAY);
    expect(i301).toBeGreaterThan(c.lastIndexOf(Numerics.RPL_WHOISSPECIAL));
    expect(i301).toBeLessThan(c.indexOf(Numerics.RPL_WHOISIDLE));
  });

  it("is absent after AWAY is cleared", () => {
    const s = setup();
    const req = s.make("r", "req");
    const t = s.make("t", "tina");
    s.send(t, "AWAY :gone");
    s.send(t, "AWAY");
    expect(codes(s.whois(req, "r", "WHOIS tina"))).not.toContain(Numerics.RPL_AWAY);
  });
});

describe("WHOIS targets (Req 2.2, 2.3)", () => {
  it("describes a network target with its host and realname", () => {
    const s = setup();
    const req = s.make("r", "req");
    const n = s.makeNetwork("n", "nina");
    n.receive("JOIN #net\r\n");
    const out = s.whois(req, "r", "WHOIS nina");
    expect(out[0]?.command).toBe(Numerics.RPL_WHOISUSER);
    expect(out[0]?.params).toEqual(["req", "nina", "nina", "10.1.2.3", "*", "Net nina"]);
    expect(codes(out)).toContain(Numerics.RPL_WHOISCHANNELS);
    expect(codes(out)).not.toContain(Numerics.RPL_WHOISSPECIAL);
    expect(out.at(-1)?.command).toBe(Numerics.RPL_ENDOFWHOIS);
  });

  it("describes a virtual target and lets a network requester query it", () => {
    const s = setup();
    s.make("t", "tina", () => ["model: kiro"]);
    const frames: string[] = [];
    const wire: Wire = {
      write: (l) => frames.push(l),
      end: () => {},
      destroy: () => {},
      bufferedBytes: () => 0,
      isDestroyed: () => false,
    };
    const session = new ConnectionSession(s.server.ctx, s.server.router, "nr", "10.9.9.9", wire);
    session.receive("NICK netreq\r\nUSER netreq 0 * :x\r\n");
    frames.length = 0;
    session.receive("WHOIS tina\r\n");
    const got = frames.join("").split("\r\n").filter((l) => l !== "");
    const cmds = got.map((l) => l.split(" ")[1]);
    expect(cmds).toEqual(["311", "312", "320", "317", "318"]);
  });
});
