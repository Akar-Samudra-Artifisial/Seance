import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { IrcMessage } from "@seance/irc-protocol";
import { ChannelRegistry } from "../src/channel-registry.js";
import type { Client } from "../src/client.js";
import { CommandRouter } from "../src/command-router.js";
import type { RouterContext } from "../src/command-router.js";
import { ConnectionManager } from "../src/connection-manager.js";
import { registerQuitHandler } from "../src/handlers/quit.js";
import { registerRegistrationHandlers } from "../src/handlers/registration.js";

/** Independent rfc1459 fold used by the model (not the code under test). */
function fold(nick: string): string {
  return nick
    .toLowerCase()
    .replace(/\[/g, "{")
    .replace(/\]/g, "}")
    .replace(/\\/g, "|")
    .replace(/~/g, "^");
}

// Small pool so collisions are frequent: case variants and rfc1459 pairs.
const NICKS = [
  "Nick", "nick", "NICK", "nIcK",
  "a[b", "a{b", "A[B",
  "a]b", "a}b",
  "a\\b", "A\\B", // `|` and `~` are not valid nick characters (Req 3.4)
  "a^b", "A^B",
  "zed", "Zed",
] as const;

const SLOTS = 4;

type Op =
  | { readonly kind: "connect"; readonly slot: number; readonly nick: string }
  | { readonly kind: "nick"; readonly slot: number; readonly nick: string }
  | { readonly kind: "quit"; readonly slot: number };

const nickArb = fc.constantFrom(...NICKS);
const slotArb = fc.integer({ min: 0, max: SLOTS - 1 });
const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("connect" as const), slot: slotArb, nick: nickArb }),
  fc.record({ kind: fc.constant("nick" as const), slot: slotArb, nick: nickArb }),
  fc.record({ kind: fc.constant("quit" as const), slot: slotArb }),
);

function setup() {
  const channels = new ChannelRegistry();
  const connections = new ConnectionManager(channels.memberIdsLookup, { serverName: "irc.test" });
  const router = new CommandRouter();
  registerRegistrationHandlers(router);
  registerQuitHandler(router);
  const ctx: RouterContext = {
    connections,
    channels,
    serverName: "irc.test",
    logger: { error: () => {} },
  };
  let n = 0;
  const connect = (): Client => {
    const sent: IrcMessage[] = [];
    const c: Client = {
      id: `c${n++}`,
      host: "host",
      registered: false,
      send: (m) => {
        sent.push(m);
      },
      close: () => {},
    };
    connections.add(c);
    return c;
  };
  const run = (c: Client, command: string, ...params: string[]) =>
    router.dispatch(ctx, c, { command, params });
  return { connections, connect, run };
}

// Feature: ircd-core, Property P6: unique nicks across NICK/QUIT sequences
describe("P6 unique nicks", () => {
  it("P6 unique nicks: no two registered clients share a case-mapped nick; QUIT releases it", () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 60 }), (ops) => {
        const { connections, connect, run } = setup();
        const live = new Map<number, Client>();
        // Model: slot -> current nick of a registered client.
        const model = new Map<number, string>();
        const heldBy = (nick: string, except?: number): boolean =>
          [...model.entries()].some(([s, v]) => s !== except && fold(v) === fold(nick));

        for (const op of ops) {
          if (op.kind === "connect") {
            if (live.has(op.slot)) continue;
            const c = connect();
            run(c, "NICK", op.nick);
            run(c, "USER", "u", "0", "*", "Real Name");
            const free = !heldBy(op.nick);
            expect(c.registered).toBe(free);
            if (free) {
              live.set(op.slot, c);
              model.set(op.slot, op.nick);
            } else {
              run(c, "QUIT", "rejected");
            }
          } else if (op.kind === "nick") {
            const c = live.get(op.slot);
            if (c === undefined) continue;
            const free = !heldBy(op.nick, op.slot);
            run(c, "NICK", op.nick);
            if (free) model.set(op.slot, op.nick);
            expect(c.nick).toBe(model.get(op.slot));
          } else {
            const c = live.get(op.slot);
            if (c === undefined) continue;
            const released = model.get(op.slot) as string;
            run(c, "QUIT", "bye");
            live.delete(op.slot);
            model.delete(op.slot);
            // A released nick is reusable unless another client holds a case-mapped equal one.
            expect(connections.isNickInUse(released)).toBe(heldBy(released));
          }

          // Invariant: registered nicks are unique under case-mapping and match the model.
          const registered = connections.clients().filter((x) => x.registered);
          const keys = registered.map((x) => fold(x.nick ?? ""));
          expect(new Set(keys).size).toBe(keys.length);
          expect(registered).toHaveLength(model.size);
          for (const nick of NICKS) {
            expect(connections.isNickInUse(nick)).toBe(heldBy(nick));
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it("a nick released by QUIT is reusable under a different case/rfc1459 spelling", () => {
    const { connections, connect, run } = setup();
    const a = connect();
    run(a, "NICK", "a[b");
    run(a, "USER", "u", "0", "*", "A");
    const b = connect();
    run(b, "NICK", "A{B");
    expect(b.nick).toBeUndefined();
    run(a, "QUIT", "bye");
    run(b, "NICK", "A{B");
    expect(connections.getByNick("a[b")?.id).toBe(b.id);
  });
});
