import { irc_lower } from "@seance/irc-protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { SessionState } from "../src/session/machine.js";
import type { SessionRecord, SessionStore } from "../src/session/session-store.js";
import { renderWhois, WHOIS_MAX_LINES } from "../src/whois/render.js";
import { type AgentSnapshot, type ChannelSnapshot, WhoisSnapshot } from "../src/whois/snapshot.js";

/**
 * P8: renderWhois is total, deterministic, derived only from the snapshot and formats two decimals.
 * **Validates: Requirements 10.4, 10.5, 10.6, 10.7, 10.8, 10.18, 10.19, 10.20**
 */
const TAG =
  "Feature: agent-runner, Property 8: renderWhois is total, deterministic, derived only from the snapshot and formats two decimals";
const RUNS = { numRuns: 200 } as const;

const STATES: readonly SessionState[] = ["idle", "prompting", "cancelling", "cooldown", "closed"];

/** Multi-byte text mixed with CJK, emoji and combining characters; may be long. */
const textArb = fc.oneof(
  fc.string({ unit: "binary", maxLength: 400 }),
  fc.string({ unit: fc.constantFrom("日", "本", "😀", "e\u0301", "a", " ", "\n", "é"), maxLength: 200 }),
);

/** Channel names without CR, LF or NUL so each is one rendered line. */
const channelNameArb = fc
  .string({ unit: fc.constantFrom("a", "B", "Z", "[", "]", "\\", "~", "日", "😀", "é", "1", "-"), maxLength: 30 })
  .map((s) => `#${s}`);

const creditsArb = fc.double({ min: 0, max: 1e9, noNaN: true });

const channelArb = fc.record({
  name: channelNameArb,
  state: fc.constantFrom(...STATES),
  credits: creditsArb,
});

type RawEntry = {
  readonly model: string | null;
  readonly tools: string | null;
  readonly away: string | null;
  readonly channels: readonly ChannelSnapshot[];
  readonly total: number;
};

const rawEntryArb: fc.Arbitrary<RawEntry> = fc.record({
  model: fc.option(textArb),
  tools: fc.option(textArb),
  away: fc.option(textArb),
  channels: fc.array(channelArb, { maxLength: 12 }),
  total: creditsArb,
});

const buildEntry = (raw: RawEntry): AgentSnapshot => {
  const channels = new Map<string, ChannelSnapshot>();
  for (const c of raw.channels) channels.set(irc_lower(c.name), c); // duplicates collapse
  return {
    ...(raw.model !== null ? { model: raw.model } : {}),
    ...(raw.tools !== null ? { tools: raw.tools } : {}),
    ...(raw.away !== null ? { away: raw.away } : {}),
    channels,
    total: raw.total,
  };
};

const snapshotArb = fc.option(rawEntryArb.map(buildEntry), { nil: undefined });

const cmp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

const expectedStatus = (entry: AgentSnapshot): string => {
  const open = [...entry.channels.values()].filter((c) => c.state !== "closed");
  if (open.some((c) => c.state === "prompting")) return "prompting";
  if (open.some((c) => c.state === "cooldown")) return "cooldown";
  if (entry.away !== undefined) return "away";
  return "idle";
};

const CREDITS_LINE = /^credits: .* (\d+\.\d{2}) \/ total (\d+\.\d{2})$/u;

describe("P8 whois snapshot purity", () => {
  it(`${TAG} (a, b: total and deterministic, entry unchanged)`, () => {
    fc.assert(
      fc.property(snapshotArb, (entry) => {
        const before = entry === undefined ? undefined : structuredClone(entry);
        const first = renderWhois(entry);
        const second = renderWhois(entry);
        expect(Array.isArray(first)).toBe(true);
        expect(first.every((l) => typeof l === "string")).toBe(true);
        expect(second).toEqual(first);
        expect(entry).toEqual(before);
        if (entry === undefined) expect(first).toEqual([]);
        expect(first.length).toBeLessThanOrEqual(WHOIS_MAX_LINES);
      }),
      RUNS,
    );
  });

  it(`${TAG} (c: status priority)`, () => {
    fc.assert(
      fc.property(rawEntryArb.map(buildEntry), (entry) => {
        const status = renderWhois(entry).filter((l) => l.startsWith("status: "));
        expect(status).toEqual([`status: ${expectedStatus(entry)}`]);
      }),
      RUNS,
    );
  });

  it(`${TAG} (d, e: two decimals, one line per open channel, ordered)`, () => {
    fc.assert(
      fc.property(rawEntryArb.map(buildEntry), (entry) => {
        const open = [...entry.channels.values()]
          .filter((c) => c.state !== "closed")
          .sort((a, b) => cmp(irc_lower(a.name), irc_lower(b.name)));
        const total = entry.total.toFixed(2);
        const expected = open.map((c) => `credits: ${c.name} ${c.credits.toFixed(2)} / total ${total}`);
        const fixed = (entry.model !== undefined ? 1 : 0) + (entry.tools !== undefined ? 1 : 0) + 1;
        const actual = renderWhois(entry).filter((l) => l.startsWith("credits: "));
        expect(actual).toEqual(expected.slice(0, WHOIS_MAX_LINES - fixed));
        for (const line of actual) expect(CREDITS_LINE.test(line)).toBe(true);
      }),
      RUNS,
    );
  });

  it(`${TAG} (f: whoisExtra is synchronous and never touches the SessionStore)`, () => {
    const boom = (): never => {
      throw new Error("SessionStore must not be called from whoisExtra");
    };
    const store: SessionStore = {
      get: (): Promise<SessionRecord | undefined> => boom(),
      put: (): Promise<void> => boom(),
      list: (): Promise<readonly SessionRecord[]> => boom(),
    };
    fc.assert(
      fc.property(
        fc.record({ model: textArb, tools: textArb }),
        fc.array(channelArb, { maxLength: 8 }),
        fc.option(textArb, { nil: undefined }),
        (profile, channels, away) => {
          const snapshot = new WhoisSnapshot();
          snapshot.register("Coder", profile);
          for (const c of channels) {
            snapshot.setState("Coder", c.name, c.state);
            snapshot.setCredits("Coder", c.name, c.credits);
          }
          snapshot.setAway("Coder", away);
          const whoisExtra = (): readonly string[] => renderWhois(snapshot.get("CODER"));
          void store; // handed to the harness around whoisExtra; any call would throw
          const result: unknown = whoisExtra();
          expect(Array.isArray(result)).toBe(true);
          expect(typeof (result as { then?: unknown }).then).not.toBe("function");
          expect(whoisExtra()).toEqual(result);
        },
      ),
      RUNS,
    );
  });
});
