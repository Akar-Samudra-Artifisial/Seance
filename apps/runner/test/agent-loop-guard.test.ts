// runner-services Requirement 11: the pure agent-to-agent loop guard (unit tests and Property 7).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AGENT_REPLY_LIMIT, AgentLoopGuard, mentionsNick } from "../src/session/agent-loop-guard.js";

describe("mentionsNick (Req 11.1)", () => {
  it.each([
    ["reviewer: ok", true],
    ["ok reviewer", true],
    ["@reviewer, please", true],
    ["REVIEWER?", true],
    ["\x0312reviewer: ok\x0F", true], // the runner's own colour code before the nick
    ["\x0312,04reviewer\x0F", true],
    ["\x02reviewer\x02 look", true],
    ["reviewers agree", false],
    ["xreviewer", false],
    ["reviewer_2 says", false],
    ["re-viewer", false],
    ["ok", false],
    ["", false],
  ])("%j -> %s", (text, expected) => {
    expect(mentionsNick(text, "reviewer")).toBe(expected);
  });

  it("treats `~` as a boundary, not a nick character (Req 11.1)", () => {
    expect(mentionsNick("~reviewer look", "reviewer")).toBe(true);
    expect(mentionsNick("reviewer~ look", "reviewer")).toBe(true);
    // `^` is a nick character, and irc_lower maps `~` to `^`: the boundary must come from the
    // original text, so `^reviewer` stays a different word.
    expect(mentionsNick("^reviewer look", "reviewer")).toBe(false);
  });

  it("uses rfc1459 case-mapping for bracket nicks", () => {
    expect(mentionsNick("hi al{x}", "Al[X]")).toBe(true);
    expect(mentionsNick("hi al{x}y", "Al[X]")).toBe(false);
  });
});

describe("AgentLoopGuard (Req 11.3 to 11.5)", () => {
  it("drops an unmentioned agent line without counting it", () => {
    const g = new AgentLoopGuard();
    expect(g.decide("#dev", "reviewer", "ok")).toBe("not-mentioned");
    expect(g.count("#dev", "reviewer")).toBe(0);
  });

  it("delivers AGENT_REPLY_LIMIT mentioned lines, then refuses until a human speaks", () => {
    expect(AGENT_REPLY_LIMIT).toBe(3);
    const g = new AgentLoopGuard();
    const decisions = Array.from({ length: 5 }, () => g.decide("#dev", "reviewer", "reviewer: ok"));
    expect(decisions).toEqual(["deliver", "deliver", "deliver", "limit", "limit"]);
    expect(g.firstLimitHit("#dev", "reviewer")).toBe(true);
    expect(g.firstLimitHit("#DEV", "REVIEWER")).toBe(false);
    g.humanSpoke("#Dev");
    expect(g.count("#dev", "reviewer")).toBe(0);
    expect(g.decide("#dev", "reviewer", "reviewer: ok")).toBe("deliver");
    expect(g.firstLimitHit("#dev", "reviewer")).toBe(true); // a new episode logs again
  });

  it("keeps counts per channel and per recipient", () => {
    const g = new AgentLoopGuard(1);
    expect(g.decide("#a", "coder", "coder hi")).toBe("deliver");
    expect(g.decide("#a", "coder", "coder hi")).toBe("limit");
    expect(g.decide("#b", "coder", "coder hi")).toBe("deliver");
    expect(g.decide("#a", "reviewer", "reviewer hi")).toBe("deliver");
    g.humanSpoke("#a");
    expect(g.count("#b", "coder")).toBe(1); // another channel is not reset
    g.clear();
    expect(g.size).toBe(0);
  });

  it("release gives one count back and drops empty entries (Req 11.3)", () => {
    const g = new AgentLoopGuard(1);
    expect(g.decide("#dev", "coder", "coder hi")).toBe("deliver");
    g.release("#DEV", "CODER");
    expect(g.count("#dev", "coder")).toBe(0);
    expect(g.hasChannel("#dev")).toBe(false);
    expect(g.decide("#dev", "coder", "coder hi")).toBe("deliver");
    expect(g.decide("#dev", "reviewer", "reviewer hi")).toBe("deliver");
    g.release("#dev", "coder");
    expect(g.count("#dev", "reviewer")).toBe(1);
    expect(g.hasChannel("#dev")).toBe(true);
    g.release("#other", "coder"); // nothing held: a no-op
    expect(g.size).toBe(1);
  });

  it("forgetChannel drops one channel's counts and limit log only (Req 11.5)", () => {
    const g = new AgentLoopGuard(1);
    g.decide("#a", "coder", "coder hi");
    g.decide("#a", "coder", "coder hi");
    expect(g.firstLimitHit("#a", "coder")).toBe(true);
    g.decide("#b", "coder", "coder hi");
    g.forgetChannel("#A");
    expect(g.hasChannel("#a")).toBe(false);
    expect(g.hasChannel("#b")).toBe(true);
    expect(g.firstLimitHit("#a", "coder")).toBe(true); // the logged entry went too
    expect(g.size).toBe(1);
  });

  it("rejects an invalid limit", () => {
    expect(() => new AgentLoopGuard(-1)).toThrow(RangeError);
    expect(() => new AgentLoopGuard(1.5)).toThrow(RangeError);
  });
});

describe("P7 agent loop guard", () => {
  const AGENTS = ["coder", "reviewer", "Al[x]"] as const;
  const CHANNELS = ["#a", "#B"] as const;
  /** A variant of a nick as an agent might write it: case changes, rfc1459 pairs, a colour code. */
  const spelled = (n: string): fc.Arbitrary<string> =>
    fc.tuple(fc.boolean(), fc.boolean(), fc.boolean()).map(([upper, coloured, tilde]) => {
      const v = upper ? n.toUpperCase().replace("[", "{").replace("]", "}") : n;
      const t = tilde ? `~${v}` : v; // `~` is a boundary (Req 11.1)
      return coloured ? `\x0312${t}\x0F` : t;
    });
  type Event =
    | { readonly kind: "human"; readonly channel: string }
    | { readonly kind: "agent"; readonly channel: string; readonly from: string; readonly text: string; readonly mentions: readonly string[] };
  const event: fc.Arbitrary<Event> = fc.oneof(
    { weight: 1, arbitrary: fc.record({ kind: fc.constant("human" as const), channel: fc.constantFrom(...CHANNELS) }) },
    {
      weight: 4,
      arbitrary: fc
        .record({
          channel: fc.constantFrom(...CHANNELS),
          from: fc.constantFrom(...AGENTS),
          mentions: fc.subarray([...AGENTS]),
        })
        .chain((e) =>
          fc
            .tuple(...e.mentions.map((m) => spelled(m)))
            .map((spellings) => ({ kind: "agent" as const, ...e, text: ["ok", ...spellings].join(", ") })),
        ),
    },
  );

  it("P7 agent loop guard: equals a plain per-(agent, channel) counter, bounded and mention-only", () => {
    fc.assert(
      fc.property(fc.array(event, { maxLength: 120 }), fc.integer({ min: 0, max: 4 }), (events, limit) => {
        const guard = new AgentLoopGuard(limit);
        const model = new Map<string, number>(); // `${channel lower}\0${agent lower}`
        const key = (c: string, a: string): string => `${c.toLowerCase()}\0${a.toLowerCase()}`;
        const sinceHuman = new Map<string, number>();
        for (const e of events) {
          if (e.kind === "human") {
            guard.humanSpoke(e.channel);
            for (const k of [...model.keys()]) if (k.startsWith(`${e.channel.toLowerCase()}\0`)) model.delete(k);
            for (const k of [...sinceHuman.keys()]) if (k.startsWith(`${e.channel.toLowerCase()}\0`)) sinceHuman.delete(k);
            continue;
          }
          for (const recipient of AGENTS) {
            if (recipient === e.from) continue; // the sender is never prompted
            const decision = guard.decide(e.channel, recipient, e.text);
            const mentioned = e.mentions.includes(recipient);
            const k = key(e.channel, recipient);
            const used = model.get(k) ?? 0;
            const expected = !mentioned ? "not-mentioned" : used >= limit ? "limit" : "deliver";
            expect(decision).toBe(expected);
            if (expected === "deliver") {
              model.set(k, used + 1);
              sinceHuman.set(k, (sinceHuman.get(k) ?? 0) + 1);
            }
            // Never more than `limit` agent prompts per pair between two human lines.
            expect(sinceHuman.get(k) ?? 0).toBeLessThanOrEqual(limit);
          }
          expect(guard.size).toBeLessThanOrEqual(AGENTS.length * CHANNELS.length);
        }
      }),
      { numRuns: 300 },
    );
  });
});
