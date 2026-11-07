import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { irc_lower } from "./casemap.js";
import { memberPrefix, sortMembers } from "./nick-order.js";
import type { Member } from "./types.js";

const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const NICK_REST = LETTERS + "0123456789-[]\\`^{|}_";

// Small alphabet so case-only and bracket-pair collisions are common.
const nickArb = fc
  .tuple(
    fc.constantFrom(..."aAbB[{".split("")),
    fc.array(fc.constantFrom(...NICK_REST.split("")), { maxLength: 6 }),
  )
  .map(([first, rest]) => first + rest.join(""));

const memberArb: fc.Arbitrary<Member> = fc.record({
  nick: nickArb,
  op: fc.boolean(),
  voice: fc.boolean(),
});

const membersArb = fc.array(memberArb, { maxLength: 40 });

function rankOf(m: Member): number {
  return m.op ? 0 : m.voice ? 1 : 2;
}

describe("nick-order properties", () => {
  it(
    "P3 nick order permutation grouped by rank",
    () => {
      // **Validates: Requirements 6.5, 6.6, 12.4, 13.1**
      fc.assert(
        fc.property(membersArb, (members) => {
          const input = [...members];
          const out = sortMembers(members);

          // Input is not mutated.
          expect(members).toEqual(input);

          // Permutation: same length, every input object appears exactly once.
          expect(out).toHaveLength(members.length);
          const counts = new Map<Member, number>();
          for (const m of out) counts.set(m, (counts.get(m) ?? 0) + 1);
          for (const m of members) expect(counts.get(m)).toBe(1);

          for (let i = 1; i < out.length; i++) {
            const prev = out[i - 1] as Member;
            const cur = out[i] as Member;
            // Operators, then voiced, then others.
            expect(rankOf(prev)).toBeLessThanOrEqual(rankOf(cur));
            // Alphabetical under irc_lower within a group.
            if (rankOf(prev) === rankOf(cur)) {
              expect(irc_lower(prev.nick) <= irc_lower(cur.nick)).toBe(true);
            }
          }

          // Prefix: @ for ops (even if voiced), + for voiced, else empty.
          for (const m of out) {
            expect(memberPrefix(m)).toBe(m.op ? "@" : m.voice ? "+" : "");
          }
        }),
        { numRuns: 200 },
      );
    },
    30_000,
  );
});
