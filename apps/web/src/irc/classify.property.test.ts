import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { KNOWN_AGENTS, classifyLine, isKnownAgent } from "./classify.js";
import { formatIrc } from "./formatter.js";

const visible = (text: string): string =>
  formatIrc(text)
    .map((s) => s.text)
    .join("");

/** A Known_Agent name with every letter randomly upper- or lower-cased. */
const agentVariant = fc
  .tuple(
    fc.constantFrom(...KNOWN_AGENTS),
    fc.array(fc.boolean(), { minLength: 12, maxLength: 12 }),
  )
  .map(([name, flags]) =>
    [...name].map((c, i) => (flags[i] === true ? c.toUpperCase() : c)).join(""),
  );

const unrelatedNick = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_\-[\]\\`^{|}]{0,14}$/);

const nearMiss = fc.oneof(
  fc.constantFrom(...KNOWN_AGENTS).map((n) => `${n}2`),
  fc.constantFrom(...KNOWN_AGENTS).map((n) => `${n}_`),
  fc.constantFrom(...KNOWN_AGENTS).map((n) => `x${n}`),
  fc.constantFrom(...KNOWN_AGENTS).map((n) => n.slice(0, -1)),
  fc.constantFrom(...KNOWN_AGENTS).map((n) => ` ${n}`),
);

const target = fc.oneof(agentVariant, unrelatedNick, nearMiss);

// Kicker nicks never contain parentheses or control characters.
const kicker = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_\-[\]\\`^{|}]{0,14}$/);

const controlCode = fc.constantFrom("\x00", "\x01", "\x02", "\x03", "\x0f", "\x1b", "\x1f", "\x7f", "\t");
const reason = fc.oneof(
  fc.constant(""),
  fc.string({ maxLength: 20, unit: "binary" }),
  fc.array(fc.oneof(controlCode, fc.constantFrom("0", "5", "12", ",", "a", " ", "(", ")")), { maxLength: 16 }).map((p) => p.join("")),
  fc.array(controlCode, { minLength: 1, maxLength: 6 }).map((p) => p.join("")),
);

function renderExorcism(agent: string, by: string, why: string): string {
  const reasonText = visible(why);
  return (
    `*** ${visible(agent)} has been exorcised by ${visible(by)}` +
    (reasonText.length > 0 ? ` (${reasonText})` : "")
  );
}

describe("kick classification properties", () => {
  // Feature: web-client-basic, Property 21: Kick classification follows the Known_Agent set
  // **Validates: Requirements 8.14, 8.18**
  it("P21 kick classification follows known agent set", { timeout: 60_000 }, () => {
    fc.assert(
      fc.property(kicker, target, reason, (by, nick, why) => {
        const result = classifyLine({ command: "KICK", kicker: by, target: nick, reason: why });

        if (!isKnownAgent(nick)) {
          expect(result.kind).toBe("kick");
          expect(result.exorcism).toBeUndefined();
          return;
        }

        expect(result.kind).toBe("exorcised-kick");
        expect(result.exorcism).toEqual({ agent: nick, kicker: by, reason: why });

        const text = renderExorcism(result.exorcism!.agent, result.exorcism!.kicker, result.exorcism!.reason);
        expect(text).toContain(visible(nick));
        expect(text).toContain(visible(by));
        expect(text.includes("(")).toBe(visible(why).length > 0);
        expect(text.includes(")")).toBe(visible(why).length > 0);
        expect(/[\x00-\x1f\x7f]/.test(text)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});
