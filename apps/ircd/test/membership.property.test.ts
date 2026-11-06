import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { IrcMessage } from "@seance/irc-protocol";
import { ChannelRegistry } from "../src/channel-registry.js";
import type { Client } from "../src/client.js";
import { CommandRouter } from "../src/command-router.js";
import type { RouterContext } from "../src/command-router.js";
import { ConnectionManager } from "../src/connection-manager.js";
import { registerJoinHandler } from "../src/handlers/join.js";
import { registerKickHandler } from "../src/handlers/kick.js";
import { registerPartHandler } from "../src/handlers/part.js";
import { registerQuitHandler } from "../src/handlers/quit.js";

const SLOTS = 4;
// Mixed case variants so channel case-mapping is exercised too.
const CHANNELS = ["#a", "#A", "#b", "#c"] as const;

type Op =
  | { readonly kind: "join"; readonly slot: number; readonly channel: string }
  | { readonly kind: "part"; readonly slot: number; readonly channel: string }
  | {
      readonly kind: "kick";
      readonly slot: number;
      readonly target: number;
      readonly channel: string;
    }
  | { readonly kind: "quit"; readonly slot: number };

const slotArb = fc.integer({ min: 0, max: SLOTS - 1 });
const chanArb = fc.constantFrom(...CHANNELS);
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("join" as const), slot: slotArb, channel: chanArb }),
  fc.record({ kind: fc.constant("part" as const), slot: slotArb, channel: chanArb }),
  fc.record({
    kind: fc.constant("kick" as const),
    slot: slotArb,
    target: slotArb,
    channel: chanArb,
  }),
  fc.record({ kind: fc.constant("quit" as const), slot: slotArb }),
);

function setup() {
  const channels = new ChannelRegistry();
  const connections = new ConnectionManager(channels.memberIdsLookup, {
    serverName: "irc.test",
  });
  const router = new CommandRouter();
  registerJoinHandler(router);
  registerPartHandler(router);
  registerKickHandler(router);
  registerQuitHandler(router);
  const ctx: RouterContext = {
    connections,
    channels,
    serverName: "irc.test",
    logger: { error: () => {} },
  };
  let n = 0;
  const connect = (): Client => {
    const id = `c${n++}`;
    const c: Client = {
      id,
      nick: `n${id}`,
      user: "u",
      host: "host",
      registered: true,
      send: (_m: IrcMessage) => {},
      close: () => {},
    };
    connections.add(c);
    return c;
  };
  const run = (c: Client, command: string, ...params: string[]) =>
    router.dispatch(ctx, c, { command, params });
  return { channels, connections, connect, run };
}

// Feature: ircd-core, Property P7: membership consistency across JOIN/PART/KICK/QUIT
describe("P7 membership consistency", () => {
  it("P7 membership consistency: channels are non-empty and members are live clients", () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 80 }), (ops) => {
        const { channels, connections, connect, run } = setup();
        const slots: Client[] = Array.from({ length: SLOTS }, () => connect());
        const live = new Set<string>(slots.map((c) => c.id));

        for (const op of ops) {
          const actor = slots[op.slot] as Client;
          const wasLive = live.has(actor.id);
          if (op.kind === "join") {
            if (!wasLive) continue;
            run(actor, "JOIN", op.channel);
          } else if (op.kind === "part") {
            if (!wasLive) continue;
            run(actor, "PART", op.channel);
          } else if (op.kind === "kick") {
            if (!wasLive) continue;
            const target = slots[op.target] as Client;
            run(actor, "KICK", op.channel, target.nick ?? "");
          } else {
            if (!wasLive) continue;
            run(actor, "QUIT", "bye");
            live.delete(actor.id);
            // Replace the dead slot with a fresh live client.
            const fresh = connect();
            slots[op.slot] = fresh;
            live.add(fresh.id);
          }

          for (const channel of channels.list()) {
            expect(channel.members.size).toBeGreaterThan(0);
            for (const id of channel.members.keys()) {
              expect(live.has(id)).toBe(true);
              expect(connections.get(id)).toBeDefined();
            }
          }
          // Dead clients appear in no channel.
          for (const client of connections.clients()) {
            expect(live.has(client.id)).toBe(true);
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});
