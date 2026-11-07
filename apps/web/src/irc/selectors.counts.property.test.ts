import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { initialState } from "./reducer.js";
import { nullRecord } from "./record.js";
import { statusCounts } from "./selectors.js";
import type { Member, Window } from "./types.js";

// Feature: web-client-polish, Property 2: Status counts
// **Validates: Requirements 6.4, 12.4**

const AGENTS = ["coder", "reviewer", "researcher"];
const nickArb = fc.oneof(
  fc.constantFrom(...AGENTS, "Coder", "REVIEWER", "Researcher"),
  fc.stringMatching(/^[a-z][a-z0-9]{0,6}$/),
);

const memberMapArb = fc
  .uniqueArray(nickArb, { selector: (n) => n.toLowerCase(), maxLength: 12 })
  .chain((nicks) =>
    fc.tuple(
      fc.constant(nicks),
      fc.array(fc.boolean(), { minLength: nicks.length, maxLength: nicks.length }),
      fc.array(fc.boolean(), { minLength: nicks.length, maxLength: nicks.length }),
    ),
  );

describe("P2 status counts", () => {
  it("P2 active scope equals a reference over the member map; exorcised nicks are not counted", () => {
    fc.assert(
      fc.property(
        memberMapArb,
        fc.uniqueArray(fc.stringMatching(/^x[a-z]{1,5}$/), { maxLength: 5 }),
        ([nicks, ops, aways], exorcised) => {
          const members = nullRecord<Member>();
          const away = nullRecord<string>();
          nicks.forEach((nick, i) => {
            members[nick.toLowerCase()] = { nick, op: ops[i] === true, voice: false };
            if (aways[i] === true) away[nick.toLowerCase()] = "gone";
          });
          const w: Window = {
            key: "c:#dev",
            kind: "channel",
            name: "#dev",
            lines: [],
            unread: false,
            mentioned: false,
            members,
            exorcised: exorcised.filter((x) => !(x in members)),
          };
          const base = initialState("alice");
          const windows = nullRecord<Window>();
          Object.assign(windows, base.windows, { [w.key]: w });
          const state = { ...base, windows, activeKey: w.key, away };

          const expected = {
            agents: nicks.filter((n) => AGENTS.includes(n.toLowerCase())).length,
            away: nicks.filter((_, i) => aways[i] === true).length,
            ops: nicks.filter((_, i) => ops[i] === true).length,
            users: nicks.length,
          };
          expect(statusCounts(state, "active")).toEqual(expected);
        },
      ),
    );
  });
});
