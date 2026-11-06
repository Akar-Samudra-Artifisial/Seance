import fc from "fast-check";
import { Numerics, irc_lower, serialize } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import type { EventName } from "../src/event-bus.js";
import { createServer } from "../src/server.js";
import { AWAYLEN, clampBytes, clampTrailing, stripControl } from "../src/text-limits.js";

// Feature: ircd-agent-commands-fixes, Property 4: Preservation - Unchanged behaviour outside the bug conditions
// Requirements 3.1 to 3.13. Inputs are restricted to the non-bug side of each finding:
// valid whoisExtra arrays of at most 10 strings, AWAY text with no edge whitespace and no
// CR/LF/NUL, and NICK changes of a client that is in no invited set. Expected replies are
// the baseline observed on the unfixed code; this file must pass before and after the fix.

const NOW = 1_700_000_000_000;
const SERVER = "seance.local";
const EVENT_NAMES: readonly EventName[] = ["irc.invite", "irc.message", "irc.mode", "irc.kick"];

function setup() {
  const error = vi.fn();
  const server = createServer(loadConfig({}), { error }, { now: () => NOW });
  const events: string[] = [];
  for (const name of EVENT_NAMES) server.events.subscribe(name, () => events.push(name));
  const make = (id: string, nick: string, whoisExtra?: () => readonly string[]) => {
    const client = server.createVirtualClient(whoisExtra === undefined ? { id } : { id, whoisExtra });
    const msgs: IrcMessage[] = [];
    client.onMessage((m) => msgs.push(m));
    client.dispatch({ command: "NICK", params: [nick] });
    client.dispatch({ command: "USER", params: [nick, "0", "*", nick] });
    return { client, msgs };
  };
  return { server, error, events, make };
}

const lines = (list: readonly IrcMessage[]): string[] => list.map((m) => serialize(m).trimEnd());

// Multi-byte heavy text: 1- to 4-byte code points plus graphemes.
const textChar = fc.oneof(
  fc.constantFrom("a", "Z", "7", "é", "☃", "😀", "👻", ":", "-"),
  fc.string({ unit: "grapheme", minLength: 1, maxLength: 1 }),
);

/** Extra lines may hold CR/LF/NUL and be long: the unfixed code already strips and clamps them. */
const extraLine = fc.string({
  unit: fc.oneof({ weight: 8, arbitrary: textChar }, { weight: 1, arbitrary: fc.constantFrom(" ", "\r", "\n", "\0", "\t") }),
  maxLength: 200,
});
const validExtra = fc.array(extraLine, { maxLength: 10 });

const NOT_EDGE = /^\s|\s$/u;
const CONTROL = /[\r\n\0]/;
/** Non-blank AWAY text that trimming would not change, also after the AWAYLEN clamp. */
const awayText = fc
  .string({ unit: fc.oneof({ weight: 6, arbitrary: textChar }, { weight: 1, arbitrary: fc.constant(" ") }), minLength: 1, maxLength: 150 })
  .filter((t) => !CONTROL.test(t) && t.trim() !== "" && !NOT_EDGE.test(t))
  .filter((t) => !NOT_EDGE.test(clampBytes(t, AWAYLEN)))
  // "AWAY :<text>" must fit one 512-byte line; texts above AWAYLEN still exercise the clamp.
  .filter((t) => Buffer.byteLength(t, "utf8") <= 400);

describe("ircd-agent-commands-fixes preservation properties", () => {
  // Feature: ircd-agent-commands-fixes, Property 4: Preservation - Unchanged behaviour outside the bug conditions
  it("P4 WHOIS with up to 10 valid extra strings: 320 in order between 312 and 301/317, one 318 last", () => {
    fc.assert(
      fc.property(validExtra, fc.option(awayText, { nil: undefined }), (extra, away) => {
        const { make, error, events } = setup();
        const req = make("r", "req");
        const spy = vi.fn(() => extra);
        const tina = make("t", "tina", spy);
        if (away !== undefined) tina.client.setAway(away);
        req.msgs.length = 0;

        req.client.dispatch({ command: "WHOIS", params: ["tina"] });

        const expected320 = extra.map((line) =>
          clampTrailing(SERVER, Numerics.RPL_WHOISSPECIAL, ["req", "tina"], stripControl(line)),
        );
        expect(req.msgs.map((m) => m.command)).toEqual([
          Numerics.RPL_WHOISUSER,
          Numerics.RPL_WHOISSERVER,
          ...expected320.map(() => Numerics.RPL_WHOISSPECIAL),
          ...(away === undefined ? [] : [Numerics.RPL_AWAY]),
          Numerics.RPL_WHOISIDLE,
          Numerics.RPL_ENDOFWHOIS,
        ]);
        expect(
          req.msgs.filter((m) => m.command === Numerics.RPL_WHOISSPECIAL).map((m) => m.params),
        ).toEqual(expected320.map((text) => ["req", "tina", text]));
        if (away !== undefined) {
          const reply = req.msgs.find((m) => m.command === Numerics.RPL_AWAY);
          expect(reply?.params).toEqual([
            "req",
            "tina",
            clampTrailing(SERVER, Numerics.RPL_AWAY, ["req", "tina"], clampBytes(away, AWAYLEN)),
          ]);
        }
        for (const m of req.msgs) serialize(m); // every line fits in 512 bytes
        expect(spy).toHaveBeenCalledTimes(1);
        expect(error).not.toHaveBeenCalled();
        expect(events).toEqual([]);
        return true;
      }),
      { numRuns: 100 },
    );
  });

  // Feature: ircd-agent-commands-fixes, Property 4: Preservation - Unchanged behaviour outside the bug conditions
  it("P4 non-blank AWAY text: stored clamped, 306 golden line, PRIVMSG gets one 301, NOTICE none", () => {
    fc.assert(
      fc.property(awayText, (text) => {
        const { make, error, events } = setup();
        const alice = make("a", "alice");
        const bob = make("b", "bob");
        alice.msgs.length = 0;
        bob.msgs.length = 0;

        alice.client.dispatch({ command: "AWAY", params: [text] });
        const stored = clampBytes(text, AWAYLEN);
        expect(alice.client.away).toBe(stored);
        expect(lines(alice.msgs)).toEqual([`:${SERVER} 306 alice :You have been marked as being away`]);

        // The virtual path agrees with the router for this input.
        bob.client.setAway(text);
        expect(bob.client.away).toBe(stored);
        bob.client.setAway();
        expect(bob.client.away).toBeUndefined();

        bob.msgs.length = 0;
        bob.client.dispatch({ command: "PRIVMSG", params: ["alice", "hi"] });
        expect(bob.msgs.map((m) => m.command)).toEqual([Numerics.RPL_AWAY]);
        expect(bob.msgs[0]?.params).toEqual([
          "bob",
          "alice",
          clampTrailing(SERVER, Numerics.RPL_AWAY, ["bob", "alice"], stored),
        ]);
        bob.msgs.length = 0;
        bob.client.dispatch({ command: "NOTICE", params: ["alice", "psst"] });
        expect(bob.msgs).toEqual([]);

        alice.msgs.length = 0;
        alice.client.dispatch({ command: "AWAY", params: [] });
        expect(lines(alice.msgs)).toEqual([`:${SERVER} 305 alice :You are no longer marked as being away`]);
        expect(alice.client.away).toBeUndefined();
        expect(error).not.toHaveBeenCalled();
        expect(events).toEqual([]);
        return true;
      }),
      { numRuns: 100 },
    );
  });

  // Distinct nick bodies; the "n" prefix keeps them apart from the invited "inv" keys.
  const nickBody = fc.string({
    // isValidNick allows letters, digits and -[]\`^{}_ (no `|`).
    unit: fc.constantFrom("a", "B", "c", "[", "]", "{", "}", "\\", "`", "^", "_", "-", "1"),
    minLength: 1,
    maxLength: 8,
  });
  const renames = fc.uniqueArray(nickBody.map((b) => `n${b}`), {
    minLength: 1,
    maxLength: 6,
    selector: (n) => irc_lower(n),
  });
  const invitedKeys = fc.uniqueArray(nickBody.map((b) => `inv${b}`), {
    maxLength: 5,
    selector: (n) => irc_lower(n),
  });

  // Feature: ircd-agent-commands-fixes, Property 4: Preservation - Unchanged behaviour outside the bug conditions
  it("P4 non-invited NICK changes: announced once to self and peer, invited sets unchanged", () => {
    fc.assert(
      fc.property(renames, invitedKeys, (nicks, invited) => {
        const { server, make, error, events } = setup();
        const alice = make("a", "alice");
        const bob = make("b", "bob");
        alice.client.dispatch({ command: "JOIN", params: ["#t"] });
        bob.client.dispatch({ command: "JOIN", params: ["#t"] });
        alice.client.dispatch({ command: "JOIN", params: ["#u"] }); // bob is not a member of #u
        const registry = server.ctx.channels;
        for (const key of invited) {
          registry.invite("#t", key);
          registry.invite("#u", key);
        }
        const before = {
          t: [...(registry.get("#t")?.invited ?? [])],
          u: [...(registry.get("#u")?.invited ?? [])],
        };

        let current = "bob";
        for (const next of nicks) {
          alice.msgs.length = 0;
          bob.msgs.length = 0;
          bob.client.dispatch({ command: "NICK", params: [next] });
          const announce = `:${current}!bob@${SERVER} NICK ${next}`;
          expect(lines(bob.msgs)).toEqual([announce]);
          expect(lines(alice.msgs)).toEqual([announce]);
          expect(bob.client.nick).toBe(next);
          current = next;
        }

        expect([...(registry.get("#t")?.invited ?? [])]).toEqual(before.t);
        expect([...(registry.get("#u")?.invited ?? [])]).toEqual(before.u);
        expect(error).not.toHaveBeenCalled();
        expect(events).toEqual([]);
        return true;
      }),
      { numRuns: 100 },
    );
  });
});
