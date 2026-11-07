import type { IrcMessage } from "@seance/irc-protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseCreditsLine } from "./credits.js";
import { initialState, reduce } from "./reducer.js";
import { CREDITS_MAX } from "./reducer.route.js";
import type { ClientState } from "./types.js";

const msg = (nick: string, text: string): IrcMessage => ({ prefix: "ircd.test", command: "320", params: ["me", nick, text] });
const run = (start: ClientState, msgs: readonly IrcMessage[]): ClientState =>
  msgs.reduce((s, m) => reduce(s, m, 1000).state, start);

describe("parseCreditsLine", () => {
  it("parses the runner format", () => {
    expect(parseCreditsLine("credits: #dev 9.60 / total 12.00")).toEqual({ channel: "#dev", used: 9.6, total: 12 });
    expect(parseCreditsLine("credits: #dev 0 / total 5")).toEqual({ channel: "#dev", used: 0, total: 5 });
  });

  it.each([
    "",
    "model: x",
    "credits: 12",
    "credits: #dev -1 / total 2",
    "credits: #dev 1 / total NaN",
    "credits: #dev 1 / total Infinity",
    "credits: #dev 1e3 / total 2",
    "credits: #dev 1 / total 2 extra",
    "credits: #dev 1.0.0 / total 2",
    "credits: #dev 1 / total 9".padEnd(40, "9") + "x",
  ])("ignores garbage %j", (text) => {
    expect(parseCreditsLine(text)).toBeUndefined();
  });

  it("only returns finite non-negative numbers", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const r = parseCreditsLine(text);
        if (r !== undefined) {
          expect(Number.isFinite(r.used) && r.used >= 0).toBe(true);
          expect(Number.isFinite(r.total) && r.total >= 0).toBe(true);
        }
      }),
    );
  });
});

describe("credits in the reducer", () => {
  it("starts empty with a null prototype", () => {
    expect(Object.getPrototypeOf(initialState("me").credits)).toBeNull();
  });

  it("stores the latest total per nick (irc_lower) and replaces earlier values", () => {
    const s = run(initialState("me"), [
      msg("Coder", "credits: #dev 1.00 / total 2.00"),
      msg("coder", "credits: #dev 9.60 / total 12.00"),
      msg("Reviewer", "credits: #dev 1 / total 3"),
    ]);
    expect(Object.keys(s.credits).sort()).toEqual(["coder", "reviewer"]);
    expect(s.credits["coder"]).toBe(12);
    expect(s.credits["reviewer"]).toBe(3);
  });

  it("ignores garbage and keeps the 320 line in the pending WHOIS", () => {
    const s = run(initialState("me"), [msg("Coder", "model: x"), msg("Coder", "credits: #dev -1 / total 2")]);
    expect(Object.keys(s.credits)).toEqual([]);
    expect(s.whoisPending["coder"]?.special).toEqual(["model: x", "credits: #dev -1 / total 2"]);
  });

  it("handles prototype names as nicks and caps at the maximum", () => {
    const nicks = ["constructor", "__proto__", ...Array.from({ length: CREDITS_MAX + 5 }, (_, i) => `a${i}`)];
    const s = run(initialState("me"), nicks.map((n) => msg(n, "credits: #c 1 / total 2")));
    expect(Object.keys(s.credits)).toHaveLength(CREDITS_MAX);
    expect(Object.keys(s.credits)).not.toContain("constructor");
    expect(Object.keys(s.credits)).toContain(`a${CREDITS_MAX + 4}`);
  });
});

// Feature: web-client-polish, Property 3: Credits total
// **Validates: Requirements 5.5, 5.6, 5.7**
describe("P3 credits total", () => {
  const nickArb = fc.constantFrom("Coder", "coder", "Reviewer", "researcher", "Alice", "bob");
  const validArb = fc.record({
    kind: fc.constant("valid" as const),
    nick: nickArb,
    used: fc.nat(1000),
    total: fc.nat(100000),
  });
  const garbageArb = fc.record({
    kind: fc.constant("garbage" as const),
    nick: nickArb,
    text: fc.constantFrom("model: x", "tools: shell", "credits: #dev -1 / total 2", "credits: #dev 1 / total NaN", "credits: 12", ""),
  });
  const lineArb = fc.oneof(validArb, garbageArb);

  it("sums the last total per distinct nick; garbage changes nothing", () => {
    fc.assert(
      fc.property(fc.array(lineArb, { minLength: 320, maxLength: 320 }), (lines) => {
        const expected = new Map<string, number>();
        const msgs = lines.map((l) => {
          if (l.kind === "valid") {
            expected.set(l.nick.toLowerCase(), l.total);
            return msg(l.nick, `credits: #dev ${l.used}.00 / total ${l.total}.00`);
          }
          return msg(l.nick, l.text);
        });
        const state = run(initialState("me"), msgs);
        const sum = Object.values(state.credits).reduce((a, b) => a + b, 0);
        const expectedSum = [...expected.values()].reduce((a, b) => a + b, 0);
        expect(sum).toBe(expectedSum);
        expect(Number.isFinite(sum) && sum >= 0).toBe(true);
        expect(Object.keys(state.credits).sort()).toEqual([...expected.keys()].sort());
      }),
    );
  });
});
