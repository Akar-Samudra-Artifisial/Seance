import { irc_lower } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { initialState, reduce } from "./reducer.js";
import { BUFFER_CAP } from "./types.js";
import type { ClientState } from "./types.js";

// Feature: web-client-basic, Property 1: Reducer is total and pure
// **Validates: Requirements 11.3, 11.6, 17.2**

const NOW = 1_700_000_000_000;

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** A state built from a few realistic messages, then deep-frozen. */
function seedState(): ClientState {
  const script: readonly IrcMessage[] = [
    { prefix: "irc.test", command: "001", params: ["me", "Welcome to Seance"] },
    { prefix: "me!u@h", command: "JOIN", params: ["#dev"] },
    { prefix: "irc.test", command: "353", params: ["me", "=", "#dev", "@me +coder al[x]"] },
    { prefix: "irc.test", command: "332", params: ["me", "#dev", "ship it"] },
    { prefix: "coder!u@h", command: "PRIVMSG", params: ["#dev", "hello me"] },
    { prefix: "al[x]!u@h", command: "PRIVMSG", params: ["me", "psst"] },
    { prefix: "me!u@h", command: "JOIN", params: ["#Ops"] },
    { prefix: "irc.test", command: "NOTICE", params: ["me", "server notice"] },
  ];
  let state = initialState("me");
  for (const msg of script) state = reduce(state, msg, NOW).state;
  return deepFreeze(state);
}

// ---------- Generators ----------

const KNOWN_COMMANDS = [
  "PRIVMSG", "NOTICE", "JOIN", "PART", "KICK", "QUIT", "NICK", "MODE", "TOPIC", "INVITE", "PING", "PONG",
  "ERROR", "CAP", "AWAY", "WHOIS", "LIST", "NAMES",
] as const;
const NUMERICS = [
  "001", "002", "003", "004", "005", "221", "301", "303", "305", "306", "311", "312", "313", "317", "318", "319",
  "320", "321", "322", "323", "324", "329", "331", "332", "333", "352", "353", "366", "372", "375", "376", "401",
  "402", "403", "404", "405", "433", "442", "461", "464", "471", "473", "474", "475", "482",
] as const;

const commandArb = fc.oneof(
  { weight: 5, arbitrary: fc.constantFrom(...KNOWN_COMMANDS) },
  { weight: 5, arbitrary: fc.constantFrom(...NUMERICS) },
  { weight: 2, arbitrary: fc.stringMatching(/^[A-Z]{1,8}$/) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 999 }).map((n) => String(n).padStart(3, "0")) },
  { weight: 1, arbitrary: fc.string({ unit: "grapheme", maxLength: 6 }) },
);

/** Params that hit real code paths (own nick, channels, nicks, modes) mixed with arbitrary Unicode. */
const paramArb = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.constantFrom(
      "me", "ME", "#dev", "#DEV", "#Ops", "#nope", "coder", "CODER", "al{x}", "Al[X]", "*", "=", "@", "+o", "-o",
      "+v", "+ov", "-ov", "+b", "+k", "", " ", ":", "@me +coder", "#dev :x",
    ),
  },
  { weight: 3, arbitrary: fc.string({ unit: "grapheme", maxLength: 20 }) },
  { weight: 2, arbitrary: fc.string({ unit: "binary", maxLength: 20 }) },
  { weight: 1, arbitrary: fc.integer({ min: -5, max: 99999 }).map(String) },
);

const prefixArb = fc.oneof(
  fc.constantFrom("", "irc.test", "me!u@h", "coder!u@h", "al[x]!u@h", "!", "@", "x!y", "nick!user@host"),
  fc.string({ unit: "grapheme", maxLength: 16 }),
);

const messageArb: fc.Arbitrary<IrcMessage> = fc
  .record({
    prefix: fc.option(prefixArb, { nil: undefined }),
    command: commandArb,
    params: fc.array(paramArb, { maxLength: 15 }),
  })
  .map(({ prefix, command, params }): IrcMessage => (prefix === undefined ? { command, params } : { prefix, command, params }));

// ---------- Invariants ----------

function checkInvariants(state: ClientState): void {
  const keys = Object.keys(state.windows);
  expect(keys).toContain(state.activeKey);
  expect([...state.order].sort()).toEqual([...keys].sort());
  expect(new Set(state.order).size).toBe(state.order.length);
  for (const [key, win] of Object.entries(state.windows)) {
    expect(win.key).toBe(key);
    expect(key).toBe(win.kind === "status" ? "status" : `${win.kind === "channel" ? "c" : "q"}:${irc_lower(win.name)}`);
    expect(win.lines.length).toBeLessThanOrEqual(BUFFER_CAP);
    if (win.members !== undefined) {
      const lowered: string[] = [];
      for (const [mk, member] of Object.entries(win.members)) {
        expect(mk).toBe(irc_lower(member.nick));
        lowered.push(irc_lower(member.nick));
      }
      expect(new Set(lowered).size).toBe(lowered.length);
    }
  }
  for (const lines of Object.values(state.closedLines)) expect(lines.length).toBeLessThanOrEqual(BUFFER_CAP);
}

describe("reducer properties", () => {
  it(
    "P1 reducer is total and pure",
    () => {
      const seed = seedState();
      fc.assert(
        fc.property(fc.array(messageArb, { minLength: 1, maxLength: 4 }), (messages) => {
          let state: ClientState = seed;
          for (const original of messages) {
            const msg = deepFreeze(structuredClone(original));
            const stateBefore = structuredClone(state);
            const msgBefore = structuredClone(msg);

            const result = reduce(state, msg, NOW);

            // Pure: inputs unchanged, and the same inputs give the same output.
            expect(state).toEqual(stateBefore);
            expect(msg).toEqual(msgBefore);
            expect(reduce(state, msg, NOW)).toEqual(result);

            checkInvariants(result.state);
            state = deepFreeze(result.state);
          }
        }),
        { numRuns: 300 },
      );
    },
    60_000,
  );
});
