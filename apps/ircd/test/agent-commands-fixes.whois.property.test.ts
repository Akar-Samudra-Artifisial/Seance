import { Numerics } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { clampTrailing, stripControl } from "../src/text-limits.js";

type Behaviour = { readonly label: string; readonly value: () => unknown };

const element = fc.oneof(
  fc.string({ unit: "grapheme", maxLength: 40 }),
  fc.string({ unit: "grapheme", maxLength: 600 }),
  fc.integer(),
  fc.constant(null),
  fc.constant(undefined),
  fc.object(),
);

const behaviour: fc.Arbitrary<Behaviour> = fc.oneof(
  fc.constant<Behaviour>({
    label: "throws",
    value: () => {
      throw new Error("boom");
    },
  }),
  fc.constant<Behaviour>({ label: "undefined", value: () => undefined }),
  fc.constant<Behaviour>({ label: "null", value: () => null }),
  fc.string().map((s): Behaviour => ({ label: "string", value: () => s })),
  fc.object().map((o): Behaviour => ({ label: "object", value: () => o })),
  fc.integer().map((n): Behaviour => ({ label: "number", value: () => n })),
  fc.array(element, { maxLength: 30 }).map((a): Behaviour => ({ label: "array", value: () => a })),
);

describe("Finding 2: WHOIS termination", () => {
  it("P2 WHOIS always ends with one 318 and at most 10 sanitized 320 lines", () => {
    // Feature: ircd-agent-commands-fixes, Property 2: Bug Condition - WHOIS always terminates with one 318
    // **Validates: Requirements 2.5, 2.6, 2.7, 2.8**
    fc.assert(
      fc.property(behaviour, (b) => {
        const server = createServer(loadConfig({}), { error: () => {} });
        const inbox: IrcMessage[] = [];
        const alice = server.createVirtualClient({ id: "a" });
        alice.onMessage((m) => inbox.push(m));
        alice.dispatch({ command: "NICK", params: ["alice"] });
        alice.dispatch({ command: "USER", params: ["alice", "0", "*", "alice"] });
        const bob = server.createVirtualClient({
          id: "b",
          whoisExtra: b.value as () => readonly string[],
        });
        bob.dispatch({ command: "NICK", params: ["bob"] });
        bob.dispatch({ command: "USER", params: ["bob", "0", "*", "bob"] });
        inbox.length = 0;

        alice.dispatch({ command: "WHOIS", params: ["bob"] });

        const codes = inbox.map((m) => m.command);
        expect(codes.filter((c) => c === Numerics.RPL_ENDOFWHOIS)).toHaveLength(1);
        expect(codes.at(-1)).toBe(Numerics.RPL_ENDOFWHOIS);

        let input: unknown;
        try {
          input = b.value();
        } catch {
          input = undefined;
        }
        const usable = Array.isArray(input)
          ? (input as readonly unknown[]).filter((x): x is string => typeof x === "string")
          : [];
        const expected = usable
          .slice(0, 10)
          .map((s) =>
            clampTrailing(server.ctx.serverName, Numerics.RPL_WHOISSPECIAL, ["alice", "bob"], stripControl(s)),
          );
        const actual = inbox
          .filter((m) => m.command === Numerics.RPL_WHOISSPECIAL)
          .map((m) => m.params[2]);
        expect(actual).toEqual(expected);
      }),
      { numRuns: 200 },
    );
  });
});
