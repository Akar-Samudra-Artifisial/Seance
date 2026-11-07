import { irc_lower } from "@seance/irc-protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { INVITE_WINDOW_MS, InviteGate, type GateDecision } from "../src/invite/invite-gate.js";

/**
 * P10: invite dedup and rate limit, compared with a straightforward reference model.
 * **Validates: Requirements 3.10, 3.13, 3.16, 3.17, 3.18**
 */
const TAG =
  "Feature: agent-runner, Property 10: at most one start per live invite key and at most N counted invites per inviter per minute";
const RUNS = { numRuns: 300 } as const;

// ---------- generators ----------

// Small pools with case variants (including rfc1459 `[` / `{`) so collisions are frequent.
const inviterArb = fc.constantFrom("Alice", "alice", "ALICE", "bob", "Bob", "[x]", "{X}");
const targetArb = fc.constantFrom("Coder", "coder", "CODER", "rev", "Rev");
const channelArb = fc.constantFrom("#a", "#A", "#b", "#B[", "#b{");
const deltaArb = fc.oneof(
  fc.constant(0),
  fc.integer({ min: 1, max: 30_000 }),
  fc.constant(60_000),
  fc.constant(59_999),
);

type Raw =
  | { readonly op: "invite"; readonly delta: number; readonly inviter: string; readonly target: string; readonly channel: string }
  | { readonly op: "release"; readonly target: string; readonly channel: string };

type Ev =
  | { readonly op: "invite"; readonly ts: number; readonly inviter: string; readonly key: string }
  | { readonly op: "release"; readonly key: string };

const keyOf = (target: string, channel: string): string => `${irc_lower(target)}\0${irc_lower(channel)}`;

const rawArb: fc.Arbitrary<Raw> = fc.oneof(
  fc.record({
    op: fc.constant("invite" as const),
    delta: deltaArb,
    inviter: inviterArb,
    target: targetArb,
    channel: channelArb,
  }),
  fc.record({ op: fc.constant("release" as const), target: targetArb, channel: channelArb }),
);

/** Builds events with non-decreasing timestamps from cumulative deltas. */
function toEvents(raws: readonly Raw[]): readonly Ev[] {
  let ts = 0;
  return raws.map((r): Ev => {
    if (r.op === "release") return { op: "release", key: keyOf(r.target, r.channel) };
    ts += r.delta;
    return { op: "invite", ts, inviter: irc_lower(r.inviter), key: keyOf(r.target, r.channel) };
  });
}

const eventsArb = fc.array(rawArb, { maxLength: 60 }).map(toEvents);
const limitArb = fc.integer({ min: 1, max: 8 });

// ---------- reference model ----------

function runModel(limit: number, events: readonly Ev[]): readonly (GateDecision | undefined)[] {
  const accepted = new Map<string, number[]>();
  const live = new Set<string>();
  return events.map((e) => {
    if (e.op === "release") {
      live.delete(e.key);
      return undefined;
    }
    if (live.has(e.key)) return { kind: "duplicate" };
    const list = accepted.get(e.inviter) ?? [];
    const inWindow = list.filter((t) => t > e.ts - INVITE_WINDOW_MS);
    if (inWindow.length >= limit) {
      const oldest = Math.min(...inWindow);
      return { kind: "rate-limited", limit, retryAfterSec: Math.ceil((oldest + INVITE_WINDOW_MS - e.ts) / 1000) };
    }
    list.push(e.ts);
    accepted.set(e.inviter, list);
    live.add(e.key);
    return { kind: "start" };
  });
}

function runGate(limit: number, events: readonly Ev[]): readonly (GateDecision | undefined)[] {
  const gate = new InviteGate(limit);
  return events.map((e) => {
    if (e.op === "release") {
      gate.release(e.key);
      return undefined;
    }
    return gate.decide(e.key, e.inviter, e.ts);
  });
}

describe("P10 invite dedup and rate limit", () => {
  it(`${TAG}: decisions equal the reference model`, () => {
    fc.assert(
      fc.property(limitArb, eventsArb, (limit, events) => {
        expect(runGate(limit, events)).toEqual(runModel(limit, events));
      }),
      RUNS,
    );
  });

  it(`${TAG}: structural invariants (a)-(d)`, () => {
    fc.assert(
      fc.property(limitArb, eventsArb, (limit, events) => {
        const decisions = runGate(limit, events);
        const liveStart = new Set<string>();
        const startsByInviter = new Map<string, number[]>();

        events.forEach((e, i) => {
          const d = decisions[i];
          if (e.op === "release") {
            liveStart.delete(e.key);
            return;
          }
          if (d === undefined) throw new Error("invite event without a decision");
          if (d.kind === "start") {
            // (a) at most one start between two releases of the same key
            expect(liveStart.has(e.key)).toBe(false);
            liveStart.add(e.key);
            const list = startsByInviter.get(e.inviter) ?? [];
            list.push(e.ts);
            startsByInviter.set(e.inviter, list);
            // (c) never more than `limit` starts in (ts - 60000, ts]
            expect(list.filter((t) => t > e.ts - INVITE_WINDOW_MS).length).toBeLessThanOrEqual(limit);
          } else if (d.kind === "duplicate") {
            // (b) a duplicate only occurs for a live key
            expect(liveStart.has(e.key)).toBe(true);
          } else {
            // (d) rate-limited reports retryAfterSec >= 1 and the configured limit, creates no key
            expect(d.retryAfterSec).toBeGreaterThanOrEqual(1);
            expect(Number.isInteger(d.retryAfterSec)).toBe(true);
            expect(d.limit).toBe(limit);
            expect(liveStart.has(e.key)).toBe(false);
          }
        });
      }),
      RUNS,
    );
  });

  it("window boundary: a start at ts is out of the window at ts + 60000 but not at ts + 59999", () => {
    const at59999 = new InviteGate(1);
    expect(at59999.decide("k1", "i", 0)).toEqual({ kind: "start" });
    expect(at59999.decide("k2", "i", 59_999)).toEqual({ kind: "rate-limited", limit: 1, retryAfterSec: 1 });
    const at60000 = new InviteGate(1);
    at60000.decide("k1", "i", 0);
    expect(at60000.decide("k2", "i", 60_000)).toEqual({ kind: "start" });
  });

  it("a duplicate is not counted and a rate-limited decision creates no key", () => {
    const gate = new InviteGate(1);
    expect(gate.decide("k1", "i", 0)).toEqual({ kind: "start" });
    expect(gate.decide("k1", "i", 1)).toEqual({ kind: "duplicate" });
    expect(gate.decide("k2", "i", 2).kind).toBe("rate-limited");
    expect(gate.decide("k2", "other", 3)).toEqual({ kind: "start" });
  });
});
