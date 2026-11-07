import { isParseError, parse, serialize } from "@seance/irc-protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { COMMANDS, parseInput, type InputContext } from "./command-parser.js";

const commandNames = [...Object.keys(COMMANDS), "privmsg", "notice", "ping", "who", "x1", "ÄÖ"];

// Free text mixing ASCII, spaces, colons, multi-byte characters and the occasional control character.
const textArb = fc.string({ maxLength: 40, unit: "binary" });
const wordArb = fc.string({ minLength: 1, maxLength: 10, unit: "grapheme-ascii" });
const argsArb = fc.array(fc.oneof(wordArb, textArb, fc.constantFrom("#chan", ":x", "+o", "\u{1F47B}")), { maxLength: 6 });

const commandInput = fc
  .tuple(fc.constantFrom(...commandNames), fc.constantFrom(" ", "  ", "\t"), argsArb)
  .map(([name, sep, args]) => `/${name}${sep}${args.join(" ")}`);

const inputArb = fc.oneof(
  commandInput,
  commandInput.map((s) => s.toUpperCase()),
  textArb,
  textArb.map((t) => `//${t}`),
  textArb.map((t) => `/${t}`),
  fc.array(textArb, { minLength: 1, maxLength: 4 }).map((l) => l.join("\n")),
);

const ctxArb: fc.Arbitrary<InputContext> = fc.record({
  ownNick: wordArb,
  active: fc.oneof(
    fc.constant({ kind: "status" as const, target: "Status" }),
    wordArb.map((w) => ({ kind: "channel" as const, target: `#${w}` })),
    wordArb.map((w) => ({ kind: "query" as const, target: w })),
  ),
  members: fc.array(wordArb, { maxLength: 4 }),
});

describe("command parser round-trip properties", () => {
  // Feature: web-client-basic, Property 6: Parsed input round-trips through the protocol
  // **Validates: Requirements 7.4, 7.12, 17.5**
  it("P6 parsed input round trips through protocol", { timeout: 60_000 }, () => {
    fc.assert(
      fc.property(inputArb, ctxArb, (input, ctx) => {
        const result = parseInput(input, ctx);
        if (result.kind !== "send") return;
        for (const m of result.messages) {
          // serialize must not throw: the parser has to reject over-long or invalid lines itself.
          const line = serialize(m);
          const back = parse(line);
          expect(isParseError(back)).toBe(false);
          expect(back).toEqual(m);
          expect(m.command).toBe(m.command.toUpperCase());
        }
      }),
      { numRuns: 500 },
    );
  });
});
