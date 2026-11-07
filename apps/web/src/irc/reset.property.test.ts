import { isParseError, parse } from "@seance/irc-protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { initialState, reduce } from "./reducer.js";
import { resetForReconnect } from "./reset.js";
import type { ClientState } from "./types.js";

// Feature: web-client-basic, Property 18: Reconnect reset keeps text and drops membership
// **Validates: Requirements 3.15**

const OWN = "me";
const nickArb = fc.constantFrom("al", "Bo", "cy", "Di", "ed");
const chanArb = fc.constantFrom("#dev", "#Ops", "#x");
const wordArb = fc.constantFrom("hello", "world", "me", "ghost", "see you");

const lineArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant(`:srv 001 ${OWN} :Welcome`),
  chanArb.map((c) => `:${OWN}!u@h JOIN ${c}`),
  fc.tuple(nickArb, chanArb).map(([n, c]) => `:${n}!u@h JOIN ${c}`),
  fc.tuple(chanArb, wordArb).map(([c, t]) => `:srv 332 ${OWN} ${c} :${t}`),
  fc.tuple(chanArb, fc.array(nickArb, { maxLength: 4 })).map(
    ([c, ns]) => `:srv 353 ${OWN} = ${c} :@${ns.join(" +")} ${OWN}`,
  ),
  chanArb.map((c) => `:srv 366 ${OWN} ${c} :End of NAMES`),
  fc.tuple(nickArb, chanArb, wordArb).map(([n, c, t]) => `:${n}!u@h PRIVMSG ${c} :${t}`),
  fc.tuple(nickArb, wordArb).map(([n, t]) => `:${n}!u@h PRIVMSG ${OWN} :${t}`),
  fc.tuple(nickArb, chanArb, wordArb).map(([n, c, t]) => `:${n}!u@h TOPIC ${c} :${t}`),
  fc.tuple(nickArb, chanArb).map(([n, c]) => `:${n}!u@h PART ${c}`),
  fc.tuple(nickArb, chanArb).map(([n, c]) => `:${OWN}!u@h MODE ${c} +o ${n}`),
  nickArb.map((n) => `:srv 311 ${OWN} ${n} u h * :Real`),
);

function run(lines: readonly string[]): ClientState {
  let s: ClientState = { ...initialState(OWN), phase: "registered" };
  let now = 1000;
  for (const line of lines) {
    const msg = parse(line);
    if (isParseError(msg)) throw new Error(`bad generated line: ${line}`);
    s = reduce(s, msg, now++).state;
  }
  return s;
}

describe("resetForReconnect properties", () => {
  it(
    "P18 reconnect reset keeps text drops membership",
    () => {
      fc.assert(
        fc.property(
          fc.array(lineArb, { maxLength: 40 }),
          fc.array(chanArb, { maxLength: 3 }),
          (lines, expecting) => {
            const built = run(lines);
            const before: ClientState = { ...built, expectingNames: expecting };
            const snapshot = structuredClone(before);

            const after = resetForReconnect(before);

            expect(before).toEqual(snapshot);
            expect(after.phase).toBe("connecting");
            expect(after.whoisPending).toEqual({});
            expect(after.expectingNames).toEqual([]);
            expect(Object.keys(after.windows)).toEqual(Object.keys(before.windows));
            for (const [key, win] of Object.entries(before.windows)) {
              const reset = after.windows[key];
              expect(reset?.lines).toEqual(win.lines);
              expect(reset?.topic).toBeUndefined();
              if (win.kind === "channel") expect(reset?.members).toEqual({});
              else expect(reset?.members).toBeUndefined();
            }
          },
        ),
        { numRuns: 100 },
      );
    },
    30_000,
  );
});
