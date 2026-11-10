import type { IrcMessage } from "@seance/irc-protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseCreditsLine } from "./credits.js";
import { initialState, reduce } from "./reducer.js";
import { CREDITS_CHANNELS_MAX, CREDITS_MAX } from "./reducer.route.js";
import { creditsForActive } from "./selectors.js";
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

// web-client-extras R8.25 (task 10.23): `credits` keeps the `used` amount per agent and channel.
describe("credits in the reducer", () => {
  it("starts empty with a null prototype", () => {
    expect(Object.getPrototypeOf(initialState("me").credits)).toBeNull();
  });

  it("stores `used` under agent and channel, not the lifetime total", () => {
    const s = run(initialState("me"), [msg("Coder", "credits: #Demo9 0.04 / total 0.36")]);
    expect(s.credits["coder"]?.["#demo9"]).toBe(0.04);
    expect(Object.getPrototypeOf(s.credits["coder"])).toBeNull();
  });

  it("replaces a later line for the same channel and keeps other channels", () => {
    const s = run(initialState("me"), [
      msg("coder", "credits: #demo9 0.04 / total 0.36"),
      msg("coder", "credits: #a 0.10 / total 0.46"),
      msg("CODER", "credits: #demo9 0.06 / total 0.48"),
      msg("coder", "credits: #b 0.20 / total 0.68"),
    ]);
    expect({ ...s.credits["coder"] }).toEqual({ "#a": 0.1, "#demo9": 0.06, "#b": 0.2 });
  });

  it("keeps two agents in one channel apart", () => {
    const s = run(initialState("me"), [
      msg("coder", "credits: #dev 0.04 / total 1"),
      msg("reviewer", "credits: #dev 0.03 / total 2"),
    ]);
    expect(s.credits["coder"]?.["#dev"]).toBe(0.04);
    expect(s.credits["reviewer"]?.["#dev"]).toBe(0.03);
  });

  it("ignores garbage and keeps the 320 line in the pending WHOIS", () => {
    const s = run(initialState("me"), [msg("Coder", "model: x"), msg("Coder", "credits: #dev -1 / total 2")]);
    expect(Object.keys(s.credits)).toEqual([]);
    expect(s.whoisPending["coder"]?.special).toEqual(["model: x", "credits: #dev -1 / total 2"]);
  });

  it("caps agents at CREDITS_MAX, dropping the oldest, and treats prototype names as plain keys", () => {
    const nicks = ["constructor", "__proto__", ...Array.from({ length: CREDITS_MAX + 5 }, (_, i) => `a${i}`)];
    const s = run(initialState("me"), nicks.map((n) => msg(n, "credits: #c 1 / total 2")));
    expect(Object.keys(s.credits)).toHaveLength(CREDITS_MAX);
    expect(Object.keys(s.credits)).not.toContain("constructor");
    expect(Object.keys(s.credits)).toContain(`a${CREDITS_MAX + 4}`);
    expect(Object.getPrototypeOf({})).toBe(Object.prototype); // nothing was written through __proto__
  });

  it("caps channels per agent at CREDITS_CHANNELS_MAX and takes __proto__ or constructor as a channel name", () => {
    const channels = ["__proto__", "constructor", ...Array.from({ length: CREDITS_CHANNELS_MAX + 3 }, (_, i) => `#c${i}`)];
    const first = run(initialState("me"), [msg("coder", "credits: __proto__ 0.5 / total 1")]);
    expect(Object.keys(first.credits["coder"] ?? {})).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(first.credits["coder"])).toBeNull();
    const s = run(initialState("me"), channels.map((c) => msg("coder", `credits: ${c} 0.01 / total 1`)));
    const kept = Object.keys(s.credits["coder"] ?? {});
    expect(kept).toHaveLength(CREDITS_CHANNELS_MAX);
    expect(kept).not.toContain("__proto__");
    expect(kept).not.toContain("constructor");
    expect(kept).toContain(`#c${CREDITS_CHANNELS_MAX + 2}`);
  });
});

// Feature: web-client-polish, Property 3: Credits total. Updated by web-client-extras task 10.23: the
// session total is the sum of the last `used` per (agent, channel), not of lifetime totals.
// **Validates: Requirements 5.5, 5.6, 5.7**
describe("P3 credits total", () => {
  const nickArb = fc.constantFrom("Coder", "coder", "Reviewer", "researcher", "Alice", "bob");
  const channelArb = fc.constantFrom("#dev", "#DEV", "#ops", "#a");
  const validArb = fc.record({
    kind: fc.constant("valid" as const),
    nick: nickArb,
    channel: channelArb,
    used: fc.nat(1000),
    total: fc.nat(100000),
  });
  const garbageArb = fc.record({
    kind: fc.constant("garbage" as const),
    nick: nickArb,
    text: fc.constantFrom("model: x", "tools: shell", "credits: #dev -1 / total 2", "credits: #dev 1 / total NaN", "credits: 12", ""),
  });
  const lineArb = fc.oneof(validArb, garbageArb);

  it("sums the last `used` per agent and channel outside a channel window; garbage changes nothing", () => {
    fc.assert(
      fc.property(fc.array(lineArb, { minLength: 1, maxLength: 320 }), (lines) => {
        const expected = new Map<string, number>();
        const msgs = lines.map((l) => {
          if (l.kind === "valid") {
            expected.set(`${l.nick.toLowerCase()} ${l.channel.toLowerCase()}`, l.used);
            return msg(l.nick, `credits: ${l.channel} ${l.used}.00 / total ${l.total}.00`);
          }
          return msg(l.nick, l.text);
        });
        const state = run(initialState("me"), msgs); // Status is active: the session total
        const expectedSum = [...expected.values()].reduce((a, b) => a + b, 0);
        expect(creditsForActive(state)).toBe(expectedSum);
      }),
    );
  });
});
