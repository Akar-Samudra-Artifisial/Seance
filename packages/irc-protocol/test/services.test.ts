import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SERVICE_NICKS, irc_lower, isServiceNick, isValidNick } from "../src/index.js";

describe("isServiceNick", () => {
  it("knows exactly ChanServ and NickServ", () => {
    expect(SERVICE_NICKS).toEqual(["ChanServ", "NickServ"]);
    for (const n of ["ChanServ", "chanserv", "CHANSERV", "NickServ", "nickSERV"]) expect(isServiceNick(n)).toBe(true);
    for (const n of ["ChanServ_", "Chan", "NickServ1", "Serv", "", "coder", "ChanServ "]) expect(isServiceNick(n)).toBe(false);
  });
});

/** A random upper/lower spelling of `nick`. */
const caseVariant = (nick: string): fc.Arbitrary<string> =>
  fc
    .array(fc.boolean(), { minLength: nick.length, maxLength: nick.length })
    .map((flags) => [...nick].map((ch, i) => (flags[i] === true ? ch.toUpperCase() : ch.toLowerCase())).join(""));

const validNick = fc.stringMatching(/^[A-Za-z[\]\\`^{}_|][A-Za-z0-9[\]\\`^{}_|-]{0,29}$/);

describe("P4 service nick case variants", () => {
  it("P4 service nick case variants: every case variant is a service nick", () => {
    fc.assert(
      fc.property(fc.constantFrom(...SERVICE_NICKS).chain(caseVariant), (variant) => {
        expect(isServiceNick(variant)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it("P4 service nick case variants: any other valid nick is not", () => {
    fc.assert(
      fc.property(validNick, (nick) => {
        fc.pre(isValidNick(nick));
        const expected = SERVICE_NICKS.some((s) => irc_lower(s) === irc_lower(nick));
        expect(isServiceNick(nick)).toBe(expected);
      }),
      { numRuns: 500 },
    );
  });

  it("P4 service nick case variants: rfc1459 pairs map onto a service nick exactly when irc_lower does", () => {
    // Service nicks have no bracket characters, so a bracket anywhere makes the nick a different one.
    fc.assert(
      fc.property(fc.constantFrom(...SERVICE_NICKS), fc.constantFrom("[", "]", "\\", "~", "{", "}", "|", "^"), fc.nat(8), (s, ch, at) => {
        const pos = at % (s.length + 1);
        const mutated = `${s.slice(0, pos)}${ch}${s.slice(pos)}`;
        expect(isServiceNick(mutated)).toBe(false);
      }),
    );
  });
});
