import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { exorcismText } from "./selectors.js";

// Feature: web-client-polish, Property 4: Exorcism text
// **Validates: Requirements 11.1, 11.2**

/** Independent rfc1459 case-mapping: ASCII letters plus [ ] \ ~ -> { } | ^. */
function lower1459(s: string): string {
  return s
    .replace(/[A-Z]/g, (c) => c.toLowerCase())
    .replace(/\[/g, "{")
    .replace(/\]/g, "}")
    .replace(/\\/g, "|")
    .replace(/~/g, "^");
}

const nickArb = fc.stringMatching(/^[A-Za-z0-9\[\]\\~]{1,9}$/);
const agentArb = fc.stringMatching(/^[a-z]{3,8}$/);

/** Swap case and bracket style so the result is equal to `s` only under rfc1459 mapping. */
function disguise(s: string): string {
  return [...s]
    .map((c, i) => {
      if (c === "[") return i % 2 === 0 ? "{" : "[";
      if (c === "]") return i % 2 === 0 ? "}" : "]";
      return i % 2 === 0 ? c.toUpperCase() : c.toLowerCase();
    })
    .join("");
}

// Invisible fillers: whitespace and format codes that the Formatter strips.
const filler = fc.constantFrom("", " ", "  ", "\x02", "\x0f", "\x1d ");

const reasonArb = (kicker: string): fc.Arbitrary<string> =>
  fc.oneof(
    filler,
    fc.stringMatching(/^[a-z ]{1,12}$/),
    fc.tuple(filler, fc.constantFrom(kicker, disguise(kicker)), filler).map((p) => p.join("")),
    fc.tuple(fc.constantFrom("\x02", ""), fc.stringMatching(/^[a-z]{1,8}$/)).map((p) => p.join("")),
  );

const partsArb = nickArb.chain((kicker) =>
  fc.record({ agent: agentArb, kicker: fc.constant(kicker), reason: reasonArb(kicker) }),
);

describe("P4 exorcism text", () => {
  it("P4 reason is present exactly when it has visible text and differs from the kicker", () => {
    fc.assert(
      fc.property(partsArb, (parts) => {
        const visible = parts.reason.replace(/[\x00-\x1f]/g, "").trim();
        const hidden = visible === "" || lower1459(visible) === lower1459(parts.kicker.trim());
        const out = exorcismText(parts);
        expect(out.agent).toBe(parts.agent);
        expect(out.kicker).toBe(parts.kicker);
        expect(out.reason).toBe(hidden ? undefined : parts.reason);
      }),
    );
  });

  it("P4 never emits an [exorcised] marker", () => {
    fc.assert(
      fc.property(partsArb, (parts) => {
        const out = exorcismText(parts);
        expect(`${out.agent} ${out.kicker} ${out.reason ?? ""}`).not.toContain("[exorcised]");
      }),
    );
  });
});
