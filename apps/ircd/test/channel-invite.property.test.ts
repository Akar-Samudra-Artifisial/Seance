import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ChannelRegistry } from "../src/channel-registry.js";

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
  "a[b", "a{b", "A[B", "A{B",
  "x]y", "x}y", "X]Y",
  "p\\q", "p|q", "P\\Q",
  "t~u", "t^u", "T~U",
  "other",
] as const;

const CHANNEL = "#crypt";

type Op =
  | { readonly kind: "invite"; readonly nick: string }
  | { readonly kind: "join"; readonly nick: string }
  | { readonly kind: "destroy" };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 5, arbitrary: fc.constantFrom(...NICKS).map((nick): Op => ({ kind: "invite", nick })) },
  { weight: 2, arbitrary: fc.constantFrom(...NICKS).map((nick): Op => ({ kind: "join", nick })) },
  { weight: 1, arbitrary: fc.constant<Op>({ kind: "destroy" }) },
);

describe("channel invites", () => {
  it("P6 invited set has one entry per rfc1459-equivalent nick", () => {
    // Feature: ircd-agent-commands, Property 6: invited set has one entry per rfc1459-equivalent nick
    // **Validates: Requirements 7.1, 7.2, 7.4, 7.6, 7.8**
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 40 }), (ops) => {
        const registry = new ChannelRegistry();
        const model = new Set<string>();
        const members: string[] = [];
        let nextId = 0;

        const create = (): void => {
          const id = `c${nextId++}`;
          const result = registry.join(id, CHANNEL, "creator");
          expect(result.kind).toBe("created");
          expect(result.channel.invited.size).toBe(0);
          members.length = 0;
          members.push(id);
        };
        create();

        for (const op of ops) {
          if (op.kind === "invite") {
            expect(registry.invite(CHANNEL, op.nick)).toBe(true);
            model.add(fold(op.nick));
          } else if (op.kind === "join") {
            const id = `c${nextId++}`;
            registry.join(id, CHANNEL, op.nick);
            members.push(id);
            model.delete(fold(op.nick));
          } else {
            for (const id of members) registry.part(id, CHANNEL);
            expect(registry.has(CHANNEL)).toBe(false);
            expect(registry.invite(CHANNEL, "Nick")).toBe(false);
            model.clear();
            create();
          }
          const invited = registry.get(CHANNEL)?.invited;
          expect(invited?.size).toBe(model.size);
          expect(new Set(invited)).toEqual(model);
        }
      }),
      { numRuns: 200 },
    );
  });
});
