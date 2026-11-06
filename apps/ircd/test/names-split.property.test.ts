import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { serialize } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import { ChannelRegistry } from "../src/channel-registry.js";
import type { Client } from "../src/client.js";
import { CommandRouter } from "../src/command-router.js";
import type { RouterContext } from "../src/command-router.js";
import { ConnectionManager } from "../src/connection-manager.js";
import { registerJoinHandler } from "../src/handlers/join.js";
import { registerNamesHandler } from "../src/handlers/names.js";

const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const NICK_CHARS = [...LETTERS, ..."0123456789-".split("")];

// Long nicks (20-30 chars, the maximum) so that 30+ members always exceed 512 bytes.
const nickArb = fc
  .tuple(
    fc.constantFrom(...LETTERS),
    fc.string({ unit: fc.constantFrom(...NICK_CHARS), minLength: 19, maxLength: 29 }),
  )
  .map(([first, rest]) => `${first}${rest}`);

type Role = "op" | "voice" | "none";

const memberArb = fc.record({
  nick: nickArb,
  role: fc.constantFrom<Role>("op", "voice", "none"),
});

// Unique under case folding so every member has a distinct nick.
const membersArb = fc.uniqueArray(memberArb, {
  minLength: 30,
  maxLength: 80,
  selector: (m) => m.nick.toLowerCase(),
});

function setup() {
  const channels = new ChannelRegistry();
  const connections = new ConnectionManager(channels.memberIdsLookup, { serverName: "irc.test" });
  const router = new CommandRouter();
  registerJoinHandler(router);
  registerNamesHandler(router);
  const ctx: RouterContext = {
    connections,
    channels,
    serverName: "irc.test",
    logger: { error: () => {} },
  };
  const add = (id: string, nick: string): Client & { readonly sent: IrcMessage[] } => {
    const sent: IrcMessage[] = [];
    const c = {
      id,
      nick,
      user: nick,
      host: "host",
      registered: true,
      sent,
      send: (m: IrcMessage) => {
        sent.push(m);
      },
      close: () => {},
    };
    connections.add(c);
    return c;
  };
  return { ctx, channels, router, add };
}

// Feature: ircd-core, Property P9: NAMES replies split without breaking nicks or the 512-byte limit
describe("P9 NAMES split", () => {
  it("P9 NAMES split: every 353 fits in 512 bytes, nicks stay whole, prefixes match roles", () => {
    fc.assert(
      fc.property(membersArb, (members) => {
        const { ctx, channels, router, add } = setup();
        const clients = members.map((m, i) => add(String(i), m.nick));
        for (const c of clients) router.dispatch(ctx, c, { command: "JOIN", params: ["#big"] });

        const channel = channels.get("#big");
        if (channel === undefined) throw new Error("channel #big should exist");
        members.forEach((m, i) => {
          const entry = channel.members.get(String(i));
          if (entry === undefined) throw new Error(`member ${m.nick} should be in #big`);
          entry.op = m.role === "op";
          entry.voice = m.role === "voice";
        });

        const observer = clients[0];
        if (observer === undefined) throw new Error("members must not be empty");
        observer.sent.length = 0;
        router.dispatch(ctx, observer, { command: "NAMES", params: ["#big"] });

        const replies = observer.sent.filter((m) => m.command === "353");
        // Each line serializes (serialize throws when over 512 bytes) and fits.
        for (const m of observer.sent) {
          expect(Buffer.byteLength(serialize(m), "utf8")).toBeLessThanOrEqual(512);
        }
        expect(replies.length).toBeGreaterThan(1);

        const expected = new Map<string, string>();
        for (const m of members) {
          expected.set(m.nick, m.role === "op" ? "@" : m.role === "voice" ? "+" : "");
        }
        const seen = new Map<string, string>();
        for (const m of replies) {
          const list = m.params[3] ?? "";
          for (const token of list.split(" ")) {
            const prefix = /^[@+]/.test(token) ? token.slice(0, 1) : "";
            const nick = token.slice(prefix.length);
            // A split nick would not match any member or would repeat.
            expect(expected.has(nick)).toBe(true);
            expect(seen.has(nick)).toBe(false);
            seen.set(nick, prefix);
          }
        }
        expect(seen).toEqual(expected);
      }),
      { numRuns: 100 },
    );
  });
});
