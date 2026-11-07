import { serialize } from "@seance/irc-protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseInput } from "./command-parser.js";
import type { InputContext } from "./command-parser.js";

const FORBIDDEN = /[\r\n\0]/;

// Control characters (CR, LF, NUL, CTCP, IRC formatting codes...) mixed with printable and multi-byte text.
const CONTROL_CHARS = Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(i)).concat("\x7f");
const charArb = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(...CONTROL_CHARS) },
  { weight: 2, arbitrary: fc.constantFrom("\r", "\n", "\r\n", "\0", " ", "#") },
  { weight: 4, arbitrary: fc.string({ unit: "grapheme", maxLength: 3 }) },
);
const bodyArb = fc.array(charArb, { maxLength: 30 }).map((parts) => parts.join(""));

// Leading part: none, a slash, a doubled slash, or a known/unknown command word.
const prefixArb = fc.constantFrom(
  "",
  "/",
  "//",
  "/me ",
  "/msg bob ",
  "/query bob ",
  "/topic ",
  "/part ",
  "/kick bob ",
  "/away ",
  "/quit ",
  "/join ",
  "/mode ",
  "/whois ",
  "/nick ",
  "/invite ",
  "/names ",
  "/list ",
  "/privmsg bob ",
  "/raw ",
  "/notice bob ",
);
const textArb = fc.tuple(prefixArb, bodyArb).map(([p, b]) => p + b);

const ctxArb: fc.Arbitrary<InputContext> = fc.oneof(
  fc.constant<InputContext>({ ownNick: "me", active: { kind: "channel", target: "#ghosts" } }),
  fc.constant<InputContext>({ ownNick: "me", active: { kind: "query", target: "alice" } }),
  fc.constant<InputContext>({ ownNick: "me", active: { kind: "status", target: "" } }),
);

describe("parseInput control characters", () => {
  // Feature: web-client-basic, Property 7: No produced line contains CR, LF or NUL
  // **Validates: Requirements 7.13, 7.14, 7.15, 7.16, 7.22, 17.14**
  it("P7 no produced line contains CR LF or NUL", { timeout: 60_000 }, () => {
    fc.assert(
      fc.property(textArb, ctxArb, (text, ctx) => {
        const result = parseInput(text, ctx);

        // NUL anywhere: never send.
        if (text.includes("\0")) {
          expect(result.kind).toBe("error");
        }

        // Multi-line command (single leading slash): error, nothing sent.
        if (/[\r\n]/.test(text) && text.startsWith("/") && !text.startsWith("//")) {
          const firstLine = text.split(/\r\n|\n|\r/, 1)[0] ?? "";
          if (firstLine.startsWith("/") && !firstLine.startsWith("//")) {
            expect(result.kind).toBe("error");
          }
        }

        if (result.kind !== "send") return;

        for (const m of result.messages) {
          expect(FORBIDDEN.test(m.command)).toBe(false);
          for (const p of m.params) expect(FORBIDDEN.test(p)).toBe(false);

          const line = serialize(m);
          expect(line.endsWith("\r\n")).toBe(true);
          expect(FORBIDDEN.test(line.slice(0, -2))).toBe(false);
        }
        for (const e of result.echo) {
          expect(FORBIDDEN.test(e.text)).toBe(false);
          expect(FORBIDDEN.test(e.target)).toBe(false);
        }
      }),
      { numRuns: 500 },
    );
  });
});
