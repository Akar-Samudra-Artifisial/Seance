import { isParseError, parse } from "@seance/irc-protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { COMMANDS, parseInput } from "./command-parser.js";
import type { InputContext } from "./command-parser.js";

const ctx: InputContext = { ownNick: "me", active: { kind: "channel", target: "#ghosts" } };

// Letters only, and not a known command (the parser lower-cases the name before lookup).
const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const nameArb = fc.oneof(
  fc.constantFrom("who", "ctcp", "WHO", "Ctcp", "ping", "version", "motd", "time", "info", "oper", "Whowas"),
  fc.array(fc.constantFrom(...LETTERS), { minLength: 1, maxLength: 12 }).map((c) => c.join("")),
).filter((name) => COMMANDS[name.toLowerCase()] === undefined);

// Printable text with multi-byte characters and spaces; no CR, LF or NUL; no leading whitespace
// (the parser strips the whitespace between the command word and its arguments).
// Trailing whitespace is generated only in the control-character test: rawCommand() trims it
// (`trimEnd`) so that `/who ` does not send an empty parameter, hence "unchanged" holds up to
// trailing whitespace.
const bodyArb = fc
  .array(fc.oneof(fc.string({ unit: "grapheme", maxLength: 4 }), fc.constantFrom(" ", "  ", ":", " :", "#")), {
    maxLength: 12,
  })
  .map((parts) => parts.join(""))
  .filter((s) => !/[\r\n\0]/.test(s) && !/^\s/.test(s));
const argsArb = bodyArb.filter((s) => !/\s$/.test(s));

describe("parseInput raw commands", () => {
  // Feature: web-client-basic, Property 10: Unknown slash commands pass through unchanged
  // **Validates: Requirements 7.9**
  it("P10 unknown slash commands pass through", { timeout: 60_000 }, () => {
    fc.assert(
      fc.property(nameArb, argsArb, (name, args) => {
        const result = parseInput(`/${name} ${args}`, ctx);
        const expected = parse(`${name.toUpperCase()} ${args}`);

        if (isParseError(expected)) {
          expect(result.kind).toBe("error");
          return;
        }
        expect(result.kind).toBe("send");
        if (result.kind !== "send") return;
        expect(result.messages).toHaveLength(1);
        const msg = result.messages[0];
        expect(msg?.command).toBe(name.toUpperCase());
        expect(msg?.params).toEqual(expected.params);
      }),
      { numRuns: 500 },
    );
  });

  it("P10 unknown slash commands pass through (no arguments)", { timeout: 60_000 }, () => {
    fc.assert(
      fc.property(nameArb, (name) => {
        const result = parseInput(`/${name}`, ctx);
        expect(result.kind).toBe("send");
        if (result.kind !== "send") return;
        expect(result.messages[0]?.command).toBe(name.toUpperCase());
        expect(result.messages[0]?.params).toEqual([]);
      }),
      { numRuns: 100 },
    );
  });

  it("P10 control characters in raw arguments are refused", { timeout: 60_000 }, () => {
    fc.assert(
      fc.property(nameArb, bodyArb, bodyArb, fc.constantFrom("\r", "\n", "\0", "\r\n"), (name, a, b, bad) => {
        const result = parseInput(`/${name} ${a}${bad}${b}`, ctx);
        expect(result.kind).toBe("error");
      }),
      { numRuns: 200 },
    );
  });
});
