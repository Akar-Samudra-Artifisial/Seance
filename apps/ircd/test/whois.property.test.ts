import fc from "fast-check";
import { irc_lower, serialize } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

// Multi-byte heavy channel-name body (2-, 3- and 4-byte characters).
const bodyChar = fc.constantFrom("a", "Z", "é", "☃", "😀", "👻", "x", "7");
const body = fc.string({ unit: bodyChar, minLength: 4, maxLength: 40 });
const flag = fc.constantFrom("op", "voice", "none");
// Index prefix keeps names distinct under rfc1459 case-mapping.
const memberships = fc
  .array(fc.record({ body, flag }), { minLength: 0, maxLength: 30 })
  .map((list) => list.map((m, i) => ({ name: `#${i}${m.body}`, flag: m.flag })));

function setup() {
  const server = createServer(loadConfig({}), { error: () => {} });
  const make = (id: string, nick: string) => {
    const client = server.createVirtualClient({ id });
    const msgs: IrcMessage[] = [];
    client.onMessage((m) => msgs.push(m));
    client.dispatch({ command: "NICK", params: [nick] });
    client.dispatch({ command: "USER", params: [nick, "0", "*", nick] });
    return { client, msgs };
  };
  return { make };
}

describe("ircd-agent-commands WHOIS properties", () => {
  // Feature: ircd-agent-commands, Property 2: WHOIS ends with one 318 and 319 lists exactly the memberships
  it("P2 WHOIS ends with one 318 and 319 lists exactly the memberships", () => {
    fc.assert(
      fc.property(memberships, (list) => {
        const { make } = setup();
        const boss = make("b", "boss");
        const target = make("t", "ghost");
        for (const m of list) {
          // boss creates the channel (becomes op), target joins, boss sets the flag.
          boss.client.dispatch({ command: "JOIN", params: [m.name] });
          target.client.dispatch({ command: "JOIN", params: [m.name] });
          if (m.flag === "op") {
            boss.client.dispatch({ command: "MODE", params: [m.name, "+o", "ghost"] });
          } else if (m.flag === "voice") {
            boss.client.dispatch({ command: "MODE", params: [m.name, "+v", "ghost"] });
          }
        }

        boss.msgs.length = 0;
        boss.client.dispatch({ command: "WHOIS", params: ["ghost"] });
        const replies = boss.msgs;
        for (const r of replies) serialize(r); // must not throw (<= 512 bytes)

        expect(replies.filter((r) => r.command === "318")).toHaveLength(1);
        expect(replies[replies.length - 1]?.command).toBe("318");

        const entries = replies
          .filter((r) => r.command === "319")
          .flatMap((r) => (r.params[2] ?? "").split(" "));
        const prefix = { op: "@", voice: "+", none: "" } as const;
        const expected = list.map((m) => `${prefix[m.flag]}${irc_lower(m.name)}`);
        expect(entries.map((e) => (e[0] === "@" || e[0] === "+" ? e[0] : "") + irc_lower(e.replace(/^[@+]/, "")))).toHaveLength(
          expected.length,
        );
        expect([...entries.map((e) => irc_lower(e))].sort()).toEqual([...expected].sort());
        if (list.length === 0) expect(replies.some((r) => r.command === "319")).toBe(false);
        return true;
      }),
      { numRuns: 100 },
    );
  });

  // Feature: ircd-agent-commands, Property 2: WHOIS ends with one 318 and 319 lists exactly the memberships
  it("P2 unknown nick: 401 then one 318, no 319", () => {
    const nick = fc.string({ unit: fc.constantFrom("a", "b", "é", "☃", "😀", "_"), minLength: 1, maxLength: 20 });
    fc.assert(
      fc.property(nick, (unknown) => {
        const { make } = setup();
        const boss = make("b", "boss");
        boss.msgs.length = 0;
        boss.client.dispatch({ command: "WHOIS", params: [unknown] });
        const codes = boss.msgs.map((r) => r.command);
        for (const r of boss.msgs) serialize(r);
        expect(codes).toEqual(["401", "318"]);
        return true;
      }),
      { numRuns: 100 },
    );
  });
});
