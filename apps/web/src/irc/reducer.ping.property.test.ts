import type { IrcMessage } from "@seance/irc-protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { initialState, reduce } from "./reducer.js";
import type { ClientState } from "./types.js";

// Feature: web-client-basic, Property 17: PING is answered silently
// **Validates: Requirements 3.13**

const TIMEOUT_MS = 30_000;

/** Tokens: empty, spaces, colons, Unicode, plain words. No CR/LF/NUL (cannot occur in parsed params). */
const tokenArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant(""),
  fc.string({ unit: "grapheme", maxLength: 40 }),
  fc.stringMatching(/^[a-z0-9.:]{1,20}$/),
  fc.constantFrom(":", "::", ":x", "a b", " leading", "trailing ", "irc.example.org", "héllo wörld 👻", "日本語 :テスト"),
).filter((s) => !/[\r\n\0]/.test(s));

/** `undefined` means a PING with no parameter at all. */
const pingArb: fc.Arbitrary<IrcMessage> = fc.oneof(
  { weight: 1, arbitrary: fc.constant<IrcMessage>({ command: "PING", params: [] }) },
  { weight: 6, arbitrary: tokenArb.map((t): IrcMessage => ({ command: "PING", params: [t] })) },
  {
    weight: 1,
    arbitrary: fc.tuple(tokenArb, tokenArb).map((p): IrcMessage => ({ command: "PING", params: [p[0], p[1]] })),
  },
);

const textArb = fc.string({ unit: "grapheme", minLength: 1, maxLength: 30 }).filter((s) => !/[\r\n\0]/.test(s));
const chanArb = fc.constantFrom("#dev", "#Ops", "#ghosts");
const nickArb = fc.constantFrom("al", "Bo", "cy");

/** Prior traffic: own joins, channel and private chat, notices, unknown commands. */
const priorMsgArb: fc.Arbitrary<IrcMessage> = fc.oneof(
  chanArb.map((c): IrcMessage => ({ prefix: "me!u@h", command: "JOIN", params: [c] })),
  fc.tuple(nickArb, chanArb, textArb).map(
    (x): IrcMessage => ({ prefix: `${x[0]}!u@h`, command: "PRIVMSG", params: [x[1], x[2]] }),
  ),
  fc.tuple(nickArb, textArb).map((x): IrcMessage => ({ prefix: `${x[0]}!u@h`, command: "PRIVMSG", params: ["me", x[1]] })),
  fc.tuple(nickArb, textArb).map((x): IrcMessage => ({ prefix: `${x[0]}!u@h`, command: "NOTICE", params: ["me", x[1]] })),
  textArb.map((t): IrcMessage => ({ prefix: "irc.test", command: "372", params: ["me", t] })),
);

const stateArb: fc.Arbitrary<ClientState> = fc
  .tuple(fc.array(priorMsgArb, { maxLength: 15 }), fc.integer({ min: 0, max: 1_000_000 }))
  .map(([msgs, t]) => msgs.reduce((s, m) => reduce(s, m, t).state, initialState("me")));

function lineCounts(state: ClientState): Record<string, number> {
  return Object.fromEntries(Object.entries(state.windows).map(([k, w]) => [k, w.lines.length]));
}

describe("reducer PING", () => {
  it(
    "P17 ping answered silently",
    () => {
      fc.assert(
        fc.property(stateArb, pingArb, fc.integer({ min: 0, max: 2_000_000 }), (state, ping, now) => {
          const before = lineCounts(state);
          const result = reduce(state, ping, now);

          const token = ping.params[0];
          const expected: readonly IrcMessage[] =
            token === undefined ? [{ command: "PONG", params: [] }] : [{ command: "PONG", params: [token] }];
          expect(result.send).toEqual(expected);

          // Silent: same windows, no window gained a line.
          expect(lineCounts(result.state)).toEqual(before);
          expect(result.mention).toBe(false);
        }),
        { numRuns: 100 },
      );
    },
    TIMEOUT_MS,
  );
});
