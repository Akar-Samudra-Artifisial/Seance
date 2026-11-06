import { Numerics } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { AWAYLEN, normalizeAway } from "../src/text-limits.js";

/** Independent model of the cleaning rules (code points, not the code under test). */
function model(text: string): string {
  const stripped = text.replace(/[\r\n\0]/g, " ").trim();
  let out = "";
  let bytes = 0;
  for (const ch of stripped) {
    const size = Buffer.byteLength(ch, "utf8");
    if (bytes + size > AWAYLEN) break;
    out += ch;
    bytes += size;
  }
  return out.trimEnd();
}

const piece = fc.constantFrom(" ", "\t", "\r", "\n", "\0", "\u00a0", "a", "Z", "é", "日", "😀", ":");
const textArb = fc.oneof(
  fc.array(piece, { maxLength: 300 }).map((p) => p.join("")),
  fc.string({ unit: "grapheme", maxLength: 300 }),
);

describe("Finding 3: AWAY normalization", () => {
  it("P3 normalizeAway matches the model and router and setAway agree", () => {
    // Feature: ircd-agent-commands-fixes, Property 3: Bug Condition - AWAY normalization
    // **Validates: Requirements 2.9**
    fc.assert(
      fc.property(textArb, (text) => {
        const expected = model(text);
        const clean = normalizeAway(text);
        expect(clean).toBe(expected);
        expect(Buffer.byteLength(clean, "utf8")).toBeLessThanOrEqual(AWAYLEN);
        expect(clean).toBe(clean.trim());

        const server = createServer(loadConfig({}), { error: () => {} });
        const inbox: IrcMessage[] = [];
        const alice = server.createVirtualClient({ id: "a" });
        alice.onMessage((m) => inbox.push(m));
        alice.dispatch({ command: "NICK", params: ["alice"] });
        alice.dispatch({ command: "USER", params: ["alice", "0", "*", "alice"] });
        inbox.length = 0;
        // The virtual path serializes first, so CR/LF/NUL cannot be dispatched; the
        // router sees them only as spaces from a real socket (covered by normalizeAway above).
        const wire = text.replace(/[\r\n\0]/g, " ");
        const wireClean = normalizeAway(wire);
        expect(wireClean).toBe(clean);
        alice.dispatch({ command: "AWAY", params: [wire] });
        const codes = inbox.map((m) => m.command);
        expect(codes).toEqual([clean === "" ? Numerics.RPL_UNAWAY : Numerics.RPL_NOWAWAY]);
        expect(alice.away ?? "").toBe(clean);

        const bob = server.createVirtualClient({ id: "b" });
        bob.setAway(text);
        expect(bob.away ?? "").toBe(clean);
      }),
      { numRuns: 200 },
    );
  });
});
