import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { INVITED_MAX, ChannelRegistry } from "../src/channel-registry.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import type { VirtualClient } from "../src/virtual-client.js";

/** Independent rfc1459 fold used by the model (not the code under test). */
function fold(nick: string): string {
  return nick
    .toLowerCase()
    .replace(/\[/g, "{")
    .replace(/\]/g, "}")
    .replace(/\\/g, "|")
    .replace(/~/g, "^");
}

const NICKS = ["Bob", "bob", "a[b", "a{b", "x", "y"] as const;
const CHANNELS = ["#a", "#b"] as const;
const SLOTS = 4;
/** Folded nicks the resolver claims when they are not connected. */
const CLAIMABLE: ReadonlySet<string> = new Set(["bob", "a{b", "y"]);

type Op =
  | { readonly kind: "connect"; readonly slot: number; readonly nick: string }
  | { readonly kind: "join"; readonly slot: number; readonly channel: string }
  | { readonly kind: "part"; readonly slot: number; readonly channel: string }
  | { readonly kind: "quit"; readonly slot: number }
  | { readonly kind: "nick"; readonly slot: number; readonly nick: string }
  | { readonly kind: "kick"; readonly slot: number; readonly target: number; readonly channel: string }
  | { readonly kind: "invite"; readonly slot: number; readonly nick: string; readonly channel: string };

const slotArb = fc.integer({ min: 0, max: SLOTS - 1 });
const nickArb = fc.constantFrom(...NICKS);
const channelArb = fc.constantFrom(...CHANNELS);

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ kind: fc.constant("connect" as const), slot: slotArb, nick: nickArb }) },
  { weight: 4, arbitrary: fc.record({ kind: fc.constant("join" as const), slot: slotArb, channel: channelArb }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("part" as const), slot: slotArb, channel: channelArb }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("quit" as const), slot: slotArb }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("nick" as const), slot: slotArb, nick: nickArb }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("kick" as const), slot: slotArb, target: slotArb, channel: channelArb }) },
  { weight: 6, arbitrary: fc.record({ kind: fc.constant("invite" as const), slot: slotArb, nick: nickArb, channel: channelArb }) },
);

/** Model of one channel: members by slot, operator slots, ordered invited keys. */
type ModelChannel = {
  readonly members: Set<number>;
  readonly ops: Set<number>;
  keys: string[];
  readonly claimed: Set<string>;
};

function record(keys: string[], key: string): string[] {
  const next = keys.filter((k) => k !== key);
  next.push(key);
  while (next.length > INVITED_MAX) next.shift();
  return next;
}

describe("Finding 1: invited-set invariant", () => {
  it("P1 invited set stays bounded, member-free, registered-or-claimed and ordered", () => {
    // Feature: ircd-agent-commands-fixes, Property 1: Bug Condition - Invited-set invariant
    // **Validates: Requirements 2.1, 2.2, 2.3, 2.4**
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 60 }), (ops) => {
        const server = createServer(
          loadConfig({}),
          { error: () => {} },
          { inviteResolver: (target) => CLAIMABLE.has(fold(target)) },
        );
        const registry = server.ctx.channels;
        const clients = new Map<number, VirtualClient>();
        const nicks = new Map<number, string>();
        const channels = new Map<string, ModelChannel>();
        let nextId = 0;

        const nickTaken = (nick: string, except?: number): boolean =>
          [...nicks].some(([slot, n]) => slot !== except && fold(n) === fold(nick));
        const modelChannel = (name: string): ModelChannel | undefined => channels.get(name);
        const leave = (slot: number, channel: string, key: string): void => {
          const ch = modelChannel(channel);
          if (ch === undefined) return;
          ch.members.delete(slot);
          ch.ops.delete(slot);
          ch.keys = ch.keys.filter((k) => k !== key);
          ch.claimed.delete(key);
          if (ch.members.size === 0) channels.delete(channel);
        };

        for (const op of ops) {
          const client = clients.get(op.slot);
          const myNick = nicks.get(op.slot);
          switch (op.kind) {
            case "connect": {
              if (client !== undefined || nickTaken(op.nick)) break;
              const c = server.createVirtualClient({ id: `c${nextId++}` });
              c.onMessage(() => {});
              c.dispatch({ command: "NICK", params: [op.nick] });
              c.dispatch({ command: "USER", params: ["user", "0", "*", "Real Name"] });
              clients.set(op.slot, c);
              nicks.set(op.slot, op.nick);
              break;
            }
            case "join": {
              if (client === undefined || myNick === undefined) break;
              client.dispatch({ command: "JOIN", params: [op.channel] });
              let ch = modelChannel(op.channel);
              if (ch === undefined) {
                ch = { members: new Set(), ops: new Set([op.slot]), keys: [], claimed: new Set() };
                channels.set(op.channel, ch);
              }
              if (!ch.members.has(op.slot)) {
                ch.members.add(op.slot);
                ch.keys = ch.keys.filter((k) => k !== fold(myNick));
                ch.claimed.delete(fold(myNick));
              }
              break;
            }
            case "part": {
              if (client === undefined || myNick === undefined) break;
              client.dispatch({ command: "PART", params: [op.channel] });
              if (modelChannel(op.channel)?.members.has(op.slot) === true) {
                leave(op.slot, op.channel, fold(myNick));
              }
              break;
            }
            case "quit": {
              if (client === undefined || myNick === undefined) break;
              client.close("bye");
              for (const name of [...channels.keys()]) leave(op.slot, name, fold(myNick));
              clients.delete(op.slot);
              nicks.delete(op.slot);
              break;
            }
            case "nick": {
              if (client === undefined || myNick === undefined) break;
              if (nickTaken(op.nick, op.slot)) break;
              client.dispatch({ command: "NICK", params: [op.nick] });
              if (op.nick !== myNick) {
                const oldKey = fold(myNick);
                const newKey = fold(op.nick);
                for (const ch of channels.values()) {
                  if (ch.members.has(op.slot)) {
                    ch.keys = ch.keys.filter((k) => k !== newKey);
                    ch.claimed.delete(newKey);
                  } else if (oldKey !== newKey && ch.keys.includes(oldKey)) {
                    ch.keys = record(ch.keys.filter((k) => k !== oldKey), newKey);
                    ch.claimed.delete(oldKey);
                    ch.claimed.delete(newKey); // now a registered nick
                  }
                }
                nicks.set(op.slot, op.nick);
              }
              break;
            }
            case "kick": {
              if (client === undefined) break;
              const targetNick = nicks.get(op.target);
              if (targetNick === undefined) break;
              client.dispatch({ command: "KICK", params: [op.channel, targetNick] });
              const ch = modelChannel(op.channel);
              if (ch !== undefined && ch.ops.has(op.slot) && ch.members.has(op.target)) {
                leave(op.target, op.channel, fold(targetNick));
              }
              break;
            }
            case "invite": {
              if (client === undefined) break;
              client.dispatch({ command: "INVITE", params: [op.nick, op.channel] });
              const ch = modelChannel(op.channel);
              if (ch === undefined || !ch.members.has(op.slot) || !ch.ops.has(op.slot)) break;
              const key = fold(op.nick);
              const targetSlot = [...nicks].find(([, n]) => fold(n) === key)?.[0];
              if (targetSlot !== undefined) {
                if (ch.members.has(targetSlot)) break;
                ch.keys = record(ch.keys, key);
                ch.claimed.delete(key);
              } else if (CLAIMABLE.has(key)) {
                ch.keys = record(ch.keys, key);
                ch.claimed.add(key);
              }
              break;
            }
          }

          // Invariants on the real registry, plus order against the model.
          for (const name of CHANNELS) {
            const real = registry.get(name);
            const model = modelChannel(name);
            const held = [...(real?.invited ?? [])];
            expect(held.length).toBeLessThanOrEqual(INVITED_MAX);
            if (real !== undefined) {
              for (const id of real.members.keys()) {
                const memberNick = server.ctx.connections.get(id)?.nick;
                expect(memberNick).toBeDefined();
                expect(held).not.toContain(fold(memberNick ?? ""));
              }
            }
            for (const key of held) {
              const registered = server.ctx.connections.getByNick(key)?.registered === true;
              expect(registered || model?.claimed.has(key) === true).toBe(true);
            }
            expect(held).toEqual(model?.keys ?? []);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it("P1 registry cap drops the oldest entry first across invites and renames", () => {
    // Feature: ircd-agent-commands-fixes, Property 1: Bug Condition - Invited-set invariant
    // **Validates: Requirements 2.3, 2.4**
    const pool = Array.from({ length: 150 }, (_, i) => `n${i}`);
    const inviteOp = fc.record({
      kind: fc.constant("invite" as const),
      nick: fc.constantFrom(...pool),
    });
    const renameOp = fc.record({
      kind: fc.constant("rename" as const),
      from: fc.constantFrom(...pool),
      to: fc.constantFrom(...pool),
    });
    fc.assert(
      fc.property(
        fc.array(fc.oneof({ weight: 5, arbitrary: inviteOp }, { weight: 1, arbitrary: renameOp }), {
          minLength: 100,
          maxLength: 400,
        }),
        (ops) => {
          const registry = new ChannelRegistry();
          registry.join("op", "#t", "op");
          let model: string[] = [];
          for (const op of ops) {
            if (op.kind === "invite") {
              registry.invite("#t", op.nick);
              model = record(model, op.nick);
            } else {
              registry.renameNick("renamer", op.from, op.to);
              if (op.from !== op.to && model.includes(op.from)) {
                model = record(model.filter((k) => k !== op.from), op.to);
              }
            }
            const held = [...(registry.get("#t")?.invited ?? [])];
            expect(held.length).toBeLessThanOrEqual(INVITED_MAX);
            expect(held).toEqual(model);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
