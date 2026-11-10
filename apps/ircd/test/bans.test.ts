import { Numerics, parse } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { BANS_MAX, banMatches, globMatch, isBanned, normalizeBanMask } from "../src/ban-mask.js";
import { loadConfig } from "../src/config.js";
import type { InviteResolver } from "../src/command-router.js";
import type { IrcModeEvent } from "../src/event-bus.js";
import { createServer } from "../src/server.js";
import type { VirtualClient } from "../src/virtual-client.js";

// Audit 10.11: `MODE +b` / `-b`, the ban list (367/368), JOIN and INVITE refusals (474), the mode event.
function setup(inviteResolver?: InviteResolver) {
  const server = createServer(loadConfig({}), { error: vi.fn() }, {
    now: () => 1_700_000_000_000,
    ...(inviteResolver !== undefined ? { inviteResolver } : {}),
  });
  const modes: IrcModeEvent[] = [];
  server.events.subscribe("irc.mode", (e) => modes.push(e));
  const inbox = new Map<string, IrcMessage[]>();
  const make = (id: string, nick: string): VirtualClient => {
    const c = server.createVirtualClient({ id });
    const out: IrcMessage[] = [];
    inbox.set(id, out);
    c.onMessage((m) => out.push(m));
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
  const clear = (): void => {
    for (const m of inbox.values()) m.length = 0;
  };
  return { server, modes, make, send, msgs, clear };
}

describe("ban masks", () => {
  it("normalises a nick, nick!user and user@host to nick!user@host in lower case", () => {
    expect(normalizeBanMask("Coder")).toBe("coder!*@*");
    expect(normalizeBanMask("Coder!bot")).toBe("coder!bot@*");
    expect(normalizeBanMask("bot@Host.example")).toBe("*!bot@host.example");
    expect(normalizeBanMask("a!b@c")).toBe("a!b@c");
  });

  it.each(["", " ", "a b", "a:b", "a,b", "a!b!c@d", "@x", "x!@y", "a\x01b", "n".repeat(101)])("rejects %j", (bad) => {
    expect(normalizeBanMask(bad)).toBeUndefined();
  });

  it("matches with * and ? and rfc1459 case-mapping", () => {
    expect(banMatches("co*!*@*", "CODER", "u", "h")).toBe(true);
    expect(banMatches("c?der!*@*", "coder", "u", "h")).toBe(true);
    expect(banMatches("*!*@evil.example", "x", "u", "evil.example")).toBe(true);
    expect(banMatches("*!*@evil.example", "x", "u", "good.example")).toBe(false);
    // Masks are stored through normalizeBanMask, which applies the case-mapping ([ and { are one letter).
    expect(banMatches(normalizeBanMask("a[b") ?? "", "A{B", "u", "h")).toBe(true);
    expect(banMatches(normalizeBanMask("A]B") ?? "", "a}b", "u", "h")).toBe(true);
  });

  it("with only a nick known, a mask counts when it names the nick alone", () => {
    expect(isBanned(new Set(["coder!*@*"]), "Coder")).toBe(true);
    expect(isBanned(new Set(["*!*@evil.example"]), "coder")).toBe(false);
    expect(isBanned(new Set(["coder!bot@*"]), "coder")).toBe(false);
  });
});

describe("MODE +b / -b and the ban list", () => {
  it("an op bans and unbans a nick; every member sees the change; the list answers 367 and 368", () => {
    const s = setup();
    const op = s.make("o", "Op");
    const bob = s.make("b", "bob");
    s.send(op, "JOIN #lab");
    s.send(bob, "JOIN #lab");
    s.clear();
    s.send(op, "MODE #lab +b coder");
    expect(s.msgs("o").map((m) => [m.command, ...m.params])).toEqual([["MODE", "#lab", "+b", "coder!*@*"]]);
    expect(s.msgs("b")).toHaveLength(1);
    s.clear();
    s.send(bob, "MODE #lab b");
    expect(s.msgs("b").map((m) => [m.command, ...m.params.slice(1)])).toEqual([
      [Numerics.RPL_BANLIST, "#lab", "coder!*@*"],
      [Numerics.RPL_ENDOFBANLIST, "#lab", "End of channel ban list"],
    ]);
    s.clear();
    s.send(op, "MODE #lab -b coder");
    expect(s.msgs("o").map((m) => [m.command, ...m.params])).toEqual([["MODE", "#lab", "-b", "coder!*@*"]]);
    s.clear();
    s.send(op, "MODE #lab b");
    expect(s.msgs("o").map((m) => m.command)).toEqual([Numerics.RPL_ENDOFBANLIST]);
  });

  it("publishes the irc.mode event with the mask, and nothing for a repeated ban", () => {
    const s = setup();
    const op = s.make("o", "Op");
    s.send(op, "JOIN #lab");
    s.send(op, "MODE #lab +b coder");
    s.send(op, "MODE #lab +b Coder");
    s.send(op, "MODE #lab -b coder");
    expect(s.modes).toEqual([
      { channel: "#lab", by: "Op", mode: "b", adding: true, target: "coder!*@*" },
      { channel: "#lab", by: "Op", mode: "b", adding: false, target: "coder!*@*" },
    ]);
  });

  it("a non-op gets 482 and the list stays empty; +b without a mask gets 461", () => {
    const s = setup();
    const op = s.make("o", "Op");
    const bob = s.make("b", "bob");
    s.send(op, "JOIN #lab");
    s.send(bob, "JOIN #lab");
    s.clear();
    s.send(bob, "MODE #lab +b coder");
    expect(s.msgs("b").map((m) => m.command)).toEqual([Numerics.ERR_CHANOPRIVSNEEDED]);
    s.clear();
    s.send(op, "MODE #lab +b");
    expect(s.msgs("o").map((m) => m.command)).toEqual([Numerics.RPL_ENDOFBANLIST]); // "+b" alone is the list query
    s.send(op, "MODE #lab +bn");
    expect(s.msgs("o").some((m) => m.command === Numerics.ERR_NEEDMOREPARAMS)).toBe(true);
    expect(s.server.ctx.channels.get("#lab")?.bans.size).toBe(0);
  });

  it("keeps at most BANS_MAX masks", () => {
    const s = setup();
    const op = s.make("o", "Op");
    s.send(op, "JOIN #lab");
    for (let i = 0; i < BANS_MAX + 5; i += 1) s.send(op, `MODE #lab +b n${i}`);
    expect(s.server.ctx.channels.get("#lab")?.bans.size).toBe(BANS_MAX);
  });

  it("answers 478 with the channel and mask when the list is full (audit 10.14)", () => {
    const s = setup();
    const op = s.make("o", "Op");
    s.send(op, "JOIN #lab");
    for (let i = 0; i < BANS_MAX; i += 1) s.send(op, `MODE #lab +b n${i}`);
    s.clear();
    s.send(op, "MODE #lab +b extra");
    const full = s.msgs("o").find((m) => m.command === Numerics.ERR_BANLISTFULL);
    expect(full?.params).toEqual(["Op", "#lab", "extra!*@*", "Channel ban list is full"]);
    // A duplicate of an existing mask is still silent.
    s.clear();
    s.send(op, "MODE #lab +b n1");
    expect(s.msgs("o")).toEqual([]);
  });

  it("names an invalid mask in a NOTICE, not in 461 (audit 10.14)", () => {
    const s = setup();
    const op = s.make("o", "Op");
    s.send(op, "JOIN #lab");
    s.clear();
    s.send(op, "MODE #lab +b a!b!c@d");
    const out = s.msgs("o");
    expect(out.some((m) => m.command === Numerics.ERR_NEEDMOREPARAMS)).toBe(false);
    const notice = out.find((m) => m.command === "NOTICE");
    expect(notice?.params[1]).toContain('"a!b!c@d"');
    expect(s.server.ctx.channels.get("#lab")?.bans.size).toBe(0);
  });

  it("stores a mask with runs of * collapsed (audit 10.13)", () => {
    expect(normalizeBanMask("a***b!*****@**")).toBe("a*b!*@*");
  });
});

// Audit 10.13: the matcher is iterative, so a hostile mask cannot backtrack.
function referenceMatch(pattern: string, text: string): boolean {
  // Plain recursion with memoisation: obviously correct, used only on short inputs.
  const memo = new Map<string, boolean>();
  const go = (p: number, t: number): boolean => {
    const key = `${p},${t}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let r: boolean;
    if (p === pattern.length) r = t === text.length;
    else if (pattern[p] === "*") r = go(p + 1, t) || (t < text.length && go(p, t + 1));
    else r = t < text.length && (pattern[p] === "?" || pattern[p] === text[t]) && go(p + 1, t + 1);
    memo.set(key, r);
    return r;
  };
  return go(0, 0);
}

describe("globMatch (audit 10.13)", () => {
  it.each([
    ["*!*@*", "a!b@c", true],
    ["co*!*@*", "coder!u@h", true],
    ["co*!*@*", "xcoder!u@h", false],
    ["c?der!*@*", "coder!u@h", true],
    ["c?der!*@*", "cder!u@h", false],
    ["*!*@evil.example", "x!u@evil.example", true],
    ["*!*@evil.example", "x!u@good.example", false],
    ["a*b*c", "abc", true],
    ["a*b*c", "axbxxc", true],
    ["a*b*c", "axbxx", false],
    ["*", "", true],
    ["?", "", false],
    ["a.c!*@*", "abc!u@h", false],
    ["a[b!*@*", "a[b!u@h", true],
  ] as const)("%s vs %s is %s", (pattern, text, expected) => {
    expect(globMatch(pattern, text)).toBe(expected);
  });

  it("agrees with a simple reference matcher", () => {
    const alphabet = fc.constantFrom("a", "b", "*", "?", "!", "@");
    fc.assert(
      fc.property(fc.array(alphabet, { maxLength: 10 }), fc.array(fc.constantFrom("a", "b", "!", "@"), { maxLength: 12 }), (p, t) => {
        expect(globMatch(p.join(""), t.join(""))).toBe(referenceMatch(p.join(""), t.join("")));
      }),
      { numRuns: 500 },
    );
  });

  it("matches the worst-case mask against 50 bans and a 100-character subject well under 50 ms", () => {
    const mask = `${"*a".repeat(46)}*b!*@*`;
    expect(mask.length).toBeLessThanOrEqual(100);
    const bans = new Set(Array.from({ length: 50 }, (_, i) => `${"*a".repeat(40 + (i % 6))}*b${i}!*@*`));
    const nick = "a".repeat(30);
    const host = "a".repeat(60);
    const started = performance.now();
    for (const b of bans) banMatches(b, nick, "a", host);
    banMatches(mask, nick, "a", host);
    expect(isBanned(bans, nick, "a", host)).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe("JOIN and INVITE of a banned nick (474)", () => {
  it("a banned client cannot join; after -b it can", () => {
    const s = setup();
    const op = s.make("o", "Op");
    const eve = s.make("e", "eve");
    s.send(op, "JOIN #lab");
    s.send(op, "MODE #lab +b eve");
    s.clear();
    s.send(eve, "JOIN #lab");
    expect(s.msgs("e").map((m) => m.command)).toEqual([Numerics.ERR_BANNEDFROMCHAN]);
    expect(s.server.ctx.channels.get("#lab")?.members.size).toBe(1);
    s.send(op, "MODE #lab -b eve");
    s.clear();
    s.send(eve, "JOIN #lab");
    expect(s.server.ctx.channels.get("#lab")?.members.size).toBe(2);
  });

  it("INVITE of a banned connected nick fails with 474 and sends no invite", () => {
    const s = setup();
    const op = s.make("o", "Op");
    const eve = s.make("e", "eve");
    s.send(op, "JOIN #lab");
    s.send(op, "MODE #lab +b eve!*@*");
    s.clear();
    s.send(op, "INVITE eve #lab");
    expect(s.msgs("o").map((m) => [m.command, m.params.at(-1)])).toEqual([
      [Numerics.ERR_BANNEDFROMCHAN, "eve is banned from #lab (+b)"],
    ]);
    expect(s.msgs("e")).toHaveLength(0);
    expect(eve.nick).toBe("eve");
  });

  it("INVITE of a banned agent nick is refused before the resolver is asked", () => {
    const resolver = vi.fn<InviteResolver>(() => true);
    const s = setup(resolver);
    const op = s.make("o", "Op");
    s.send(op, "JOIN #lab");
    s.send(op, "MODE #lab +b coder");
    s.clear();
    s.send(op, "INVITE coder #lab");
    expect(s.msgs("o").map((m) => m.command)).toEqual([Numerics.ERR_BANNEDFROMCHAN]);
    expect(resolver).not.toHaveBeenCalled();
    s.send(op, "MODE #lab -b coder");
    s.clear();
    s.send(op, "INVITE coder #lab");
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(s.msgs("o").map((m) => m.command)).toEqual([Numerics.RPL_INVITING]);
  });

  it("a ban in one channel does not affect another", () => {
    const s = setup(() => true);
    const op = s.make("o", "Op");
    s.send(op, "JOIN #a");
    s.send(op, "JOIN #b");
    s.send(op, "MODE #a +b coder");
    s.clear();
    s.send(op, "INVITE coder #b");
    expect(s.msgs("o").map((m) => m.command)).toEqual([Numerics.RPL_INVITING]);
  });
});
