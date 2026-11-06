import fc from "fast-check";
import { serialize } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import type { VirtualClient } from "../src/virtual-client.js";

// Mix of ASCII and 2-, 3- and 4-byte characters (byte length != string length).
const textChar = fc.constantFrom("a", "Z", " ", "é", "☃", "😀", "x", "7");
const awayText = fc.oneof(
  fc.constant(""),
  fc.string({ unit: textChar, minLength: 1, maxLength: 120 }),
);
// `undefined` models `AWAY` sent with no parameter at all.
const awayCommand = fc.option(awayText, { nil: undefined });

// ---- P1 arbitraries -------------------------------------------------------

const nickBody = fc.string({
  unit: fc.constantFrom(..."abcxyzABC019_-[]{}`^\\"),
  minLength: 0,
  maxLength: 28,
});
// Distinct first letters keep the four nicks unique under rfc1459 case-mapping.
const nickWith = (first: string) => nickBody.map((body) => `${first}${body}`);
const hostArb = fc.string({ unit: fc.constantFrom(..."abcxyz.-019"), minLength: 1, maxLength: 60 });
const realnameArb = fc.string({ unit: textChar, minLength: 0, maxLength: 150 });
const channelNameArb = fc
  .string({ unit: fc.constantFrom("a", "Z", "7", "é", "☃", "😀", "_"), minLength: 1, maxLength: 45 })
  .map((s) => `#${s}`);
// Includes CR, LF, NUL and other control characters.
const controlChar = fc.constantFrom("\r", "\n", "\0", "\x01", "\x07", "\x1b", "\x7f", "\t");
const wildText = (maxLength: number) =>
  fc.string({
    unit: fc.oneof({ weight: 4, arbitrary: textChar }, { weight: 1, arbitrary: controlChar }),
    minLength: 0,
    maxLength,
  });
// Safe for dispatch(): no CR, LF or NUL (those are rejected by serialize()).
const dispatchableText = fc.string({
  unit: fc.oneof(
    { weight: 4, arbitrary: textChar },
    { weight: 1, arbitrary: fc.constantFrom("\x01", "\x07", "\x1b", "\x7f", "\t") },
  ),
  minLength: 1,
  maxLength: 120,
});

const p1Scenario = fc.record({
  opNick: nickWith("o"),
  agentNick: nickWith("a"),
  peerNick: nickWith("p"),
  ghostNick: nickWith("g"),
  hosts: fc.tuple(hostArb, hostArb, hostArb),
  realnames: fc.tuple(realnameArb, realnameArb),
  channels: fc.array(channelNameArb, { minLength: 1, maxLength: 4 }),
  agentJoins: fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
  extra: fc.array(wildText(600), { maxLength: 5 }),
  awayDispatch: dispatchableText,
  awayRaw: wildText(600),
  now: fc.integer({ min: 0, max: 2 ** 41 }),
  resolverClaims: fc.boolean(),
});

describe("ircd-agent-commands properties", () => {
  // Feature: ircd-agent-commands, Property 3: 301 appears iff the last AWAY carried non-empty text
  it("P3 away state model: 301 iff the last AWAY had non-empty text", () => {
    fc.assert(
      fc.property(fc.array(awayCommand, { minLength: 1, maxLength: 12 }), (sequence) => {
        const server = createServer(loadConfig({}), { error: () => {} });
        const inbox = new Map<string, IrcMessage[]>();
        const make = (id: string, nick: string) => {
          const client = server.createVirtualClient({ id });
          const msgs: IrcMessage[] = [];
          inbox.set(id, msgs);
          client.onMessage((m) => msgs.push(m));
          client.dispatch({ command: "NICK", params: [nick] });
          client.dispatch({ command: "USER", params: [nick, "0", "*", nick] });
          return client;
        };
        const agent = make("a", "agent");
        const op = make("o", "oper");

        for (const text of sequence) {
          agent.dispatch({ command: "AWAY", params: text === undefined ? [] : [text] });
        }
        const last = sequence[sequence.length - 1];
        const expectAway = last !== undefined && last.length > 0;

        const seen = inbox.get("o") ?? [];
        seen.length = 0;
        op.dispatch({ command: "PRIVMSG", params: ["agent", "ping"] });
        const got301 = seen.some((m) => m.command === "301");
        return got301 === expectAway;
      }),
      { numRuns: 150 },
    );
  });
  // Feature: ircd-agent-commands, Property 1: every WHOIS/AWAY/INVITE reply serializes to <= 512 bytes
  it("P1 reply line bound: WHOIS, AWAY and INVITE output serializes to <= 512 bytes", () => {
    fc.assert(
      fc.property(p1Scenario, (sc) => {
        const server = createServer(
          loadConfig({}),
          { error: () => {} },
          { now: () => sc.now, inviteResolver: () => sc.resolverClaims },
        );
        const problems: string[] = [];
        let armed = false;
        const make = (
          id: string,
          nick: string,
          host: string,
          realname: string,
          whoisExtra?: () => readonly string[],
        ): VirtualClient => {
          const client = server.createVirtualClient({
            id,
            host,
            ...(whoisExtra !== undefined ? { whoisExtra } : {}),
          });
          // deliver() swallows listener errors, so record failures ourselves.
          client.onMessage((m) => {
            if (!armed) return;
            try {
              const bytes = Buffer.byteLength(serialize(m), "utf8");
              if (bytes > 512) problems.push(`${m.command}: ${bytes} bytes`);
            } catch (error) {
              problems.push(`${m.command}: ${error instanceof Error ? error.message : String(error)}`);
            }
          });
          client.dispatch({ command: "NICK", params: [nick] });
          client.dispatch({ command: "USER", params: [id, "0", "*", realname] });
          return client;
        };

        const op = make("o", sc.opNick, sc.hosts[0], sc.realnames[0]);
        const agent = make("a", sc.agentNick, sc.hosts[1], sc.realnames[1], () => sc.extra);
        make("p", sc.peerNick, sc.hosts[2], "peer");
        for (const [i, name] of sc.channels.entries()) {
          op.dispatch({ command: "JOIN", params: [name] });
          if (sc.agentJoins[i] === true) agent.dispatch({ command: "JOIN", params: [name] });
        }
        agent.setAway(sc.awayRaw);

        armed = true;
        for (const who of [op, agent]) {
          who.dispatch({ command: "WHOIS", params: [sc.agentNick] });
          who.dispatch({ command: "WHOIS", params: [sc.opNick] });
        }
        agent.dispatch({ command: "AWAY", params: [sc.awayDispatch] });
        op.dispatch({ command: "WHOIS", params: [sc.agentNick] });
        agent.dispatch({ command: "AWAY", params: [] });
        agent.dispatch({ command: "AWAY", params: [""] });
        for (const name of sc.channels) {
          for (const target of [sc.agentNick, sc.peerNick, sc.ghostNick]) {
            op.dispatch({ command: "INVITE", params: [target, name] });
          }
        }
        expect(problems).toEqual([]);
      }),
      { numRuns: 150 },
    );
  });
});
