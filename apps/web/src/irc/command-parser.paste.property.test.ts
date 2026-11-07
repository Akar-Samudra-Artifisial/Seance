import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseInput } from "./command-parser.js";
import type { InputContext } from "./command-parser.js";

const BAD = /[\r\n\0]/;

const bodyArb = fc.string({ unit: "grapheme", maxLength: 30 }).filter((s) => !BAD.test(s));

// Non-empty line text: plain, starting with `/`, or starting with `//`.
const lineArb = fc
  .tuple(fc.constantFrom("", "/", "//", "/me ", "/join ", "/quit "), bodyArb)
  .map(([p, b]) => p + b)
  .filter((s) => s.length > 0);

const rawLineArb = fc.oneof({ weight: 3, arbitrary: lineArb }, { weight: 1, arbitrary: fc.constant("") });

const sepArb = fc.constantFrom("\r\n", "\n", "\r");

const isSingleSlash = (s: string): boolean => s.startsWith("/") && !s.startsWith("//");

// Multi-line text: at least two raw lines, at least one non-empty, first line not a single-slash command.
const pasteArb = fc
  .array(rawLineArb, { minLength: 2, maxLength: 12 })
  .filter((lines) => lines.some((l) => l.length > 0) && !isSingleSlash(lines[0] ?? ""))
  .chain((lines) =>
    fc
      .array(sepArb, { minLength: lines.length - 1, maxLength: lines.length - 1 })
      .map((seps) => ({
        lines,
        text: lines.reduce((acc, l, i) => (i === 0 ? l : acc + (seps[i - 1] ?? "\n") + l), ""),
      })),
  );

const ctxArb: fc.Arbitrary<InputContext> = fc.oneof(
  fc.constant<InputContext>({ ownNick: "me", active: { kind: "channel", target: "#ghosts" } }),
  fc.constant<InputContext>({ ownNick: "me", active: { kind: "query", target: "alice" } }),
);

describe("parseInput multi-line paste", () => {
  // Feature: web-client-basic, Property 9: Multi-line paste splits into plain messages
  // **Validates: Requirements 7.17, 7.19**
  it("P9 multi-line paste splits into plain messages", { timeout: 60_000 }, () => {
    fc.assert(
      fc.property(pasteArb, ctxArb, ({ lines, text }, ctx) => {
        const expected = lines.filter((l) => l.length > 0);
        const target = ctx.active.target;
        const result = parseInput(text, ctx);

        if (expected.length <= 5) {
          expect(result.kind).toBe("send");
          if (result.kind !== "send") return;
          expect(result.messages).toEqual(expected.map((l) => ({ command: "PRIVMSG", params: [target, l] })));
          expect(result.echo).toEqual(expected.map((l) => ({ target, text: l })));
        } else {
          expect(result).toEqual({ kind: "confirm-paste", lines: expected, target });
        }
      }),
      { numRuns: 500 },
    );
  });
});
