// Feature: web-client-pixel-match, Property 3: Event colour
// **Validates: Requirements 6.1, 6.3**
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EVENT_LINE_KINDS } from "../irc/index.js";
import type { Line, LineKind } from "../irc/index.js";
import { lineClass } from "./ChatLine.js";

const ALL_KINDS: readonly LineKind[] = [
  "message", "action", "notice", "join", "part", "quit", "nick", "mode", "topic", "invite", "kick", "exorcised",
  "exorcised-kick", "tool", "tool-denied", "system", "error", "motd", "numeric", "whois", "local",
];

const lineOf = (kind: LineKind, text: string): Line => ({ id: 1, at: 0, kind, text, mention: false, own: false });

describe("P3 event colour", () => {
  it("P3 lineClass is the event green exactly for EVENT_LINE_KINDS", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_KINDS), fc.string({ maxLength: 40 }), (kind, text) => {
        const cls = lineClass(lineOf(kind, text));
        expect(cls.includes("text-event-green")).toBe(EVENT_LINE_KINDS.includes(kind));
      }),
      { numRuns: 200 },
    );
  });

  it("never colours kick, exorcism, message or notice lines green", () => {
    for (const kind of ["kick", "exorcised", "exorcised-kick", "message", "notice"] as const) {
      expect(lineClass(lineOf(kind, "x"))).not.toContain("text-event-green");
    }
  });

  it("covers mode, topic and invite, as in the 00 Style guide", () => {
    expect(EVENT_LINE_KINDS).toEqual(expect.arrayContaining(["join", "mode", "topic", "invite"]));
    expect(lineClass(lineOf("topic", "No topic is set for #dev"))).toContain("text-event-green");
  });
});
