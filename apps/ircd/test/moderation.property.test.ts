import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { IrcMessage } from "@seance/irc-protocol";
import { ChannelRegistry } from "../src/channel-registry.js";
import type { Client } from "../src/client.js";
import { CommandRouter } from "../src/command-router.js";
import type { RouterContext } from "../src/command-router.js";
import { ConnectionManager } from "../src/connection-manager.js";
import { registerJoinHandler } from "../src/handlers/join.js";
import { registerPrivmsgHandler } from "../src/handlers/privmsg.js";

type TestClient = Client & { readonly sent: IrcMessage[] };

function makeClient(id: string, nick: string): TestClient {
  const sent: IrcMessage[] = [];
  return {
    id,
    nick,
    user: nick,
    host: "host",
    registered: true,
    sent,
    send: (m) => {
      sent.push(m);
    },
    close: () => {},
  };
}

interface MemberSpec {
  readonly op: boolean;
  readonly voice: boolean;
}

// Feature: ircd-core, Property P8
describe("P8 moderation", () => {
  it("delivers a +m channel message iff the sender has +o or +v (Req 6.6)", () => {
    const memberArb = fc.record({ op: fc.boolean(), voice: fc.boolean() });
    fc.assert(
      fc.property(
        fc.array(memberArb, { minLength: 2, maxLength: 8 }),
        fc.nat(),
        fc.string({ minLength: 1, maxLength: 40 }).filter((s) => !/[\r\n\0]/.test(s)),
        (specs: readonly MemberSpec[], pick: number, text: string) => {
          const channels = new ChannelRegistry();
          const connections = new ConnectionManager(channels.memberIdsLookup, {
            serverName: "irc.test",
          });
          const router = new CommandRouter();
          registerJoinHandler(router);
          registerPrivmsgHandler(router);
          const ctx: RouterContext = {
            connections,
            channels,
            serverName: "irc.test",
            logger: { error: () => {} },
          };
          const clients = specs.map((_, i) => {
            const c = makeClient(String(i), `nick${i}`);
            connections.add(c);
            router.dispatch(ctx, c, { command: "JOIN", params: ["#chan"] });
            return c;
          });
          const ch = channels.get("#chan");
          if (ch === undefined) throw new Error("channel missing");
          specs.forEach((s, i) => {
            const m = ch.members.get(String(i));
            if (m === undefined) throw new Error("member missing");
            m.op = s.op;
            m.voice = s.voice;
          });
          ch.modes.moderated = true;
          for (const c of clients) c.sent.length = 0;

          const idx = pick % specs.length;
          const sender = clients[idx];
          const spec = specs[idx];
          if (sender === undefined || spec === undefined) throw new Error("sender missing");
          router.dispatch(ctx, sender, { command: "PRIVMSG", params: ["#chan", text] });

          const allowed = spec.op || spec.voice;
          for (const c of clients) {
            if (c === sender) continue;
            if (allowed) {
              expect(c.sent).toEqual([
                { prefix: `nick${idx}!nick${idx}@host`, command: "PRIVMSG", params: ["#chan", text] },
              ]);
            } else {
              expect(c.sent).toEqual([]);
            }
          }
          if (allowed) {
            expect(sender.sent).toEqual([]);
          } else {
            expect(sender.sent).toEqual([
              {
                prefix: "irc.test",
                command: "404",
                params: [sender.nick, "#chan", "Cannot send to channel"],
              },
            ]);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
