// Feature: web-client-pixel-match, Property 4: No empty lines
// **Validates: Requirements 9.2, 9.3**
import type { IrcMessage } from "@seance/irc-protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { hasVisibleText } from "./formatter.js";
import { initialState, reduce } from "./reducer.js";
import type { ClientState } from "./types.js";

const m = (command: string, params: string[], prefix: string): IrcMessage => ({ prefix, command, params });

function joined(): ClientState {
  let s: ClientState = { ...initialState(), phase: "registering" };
  s = reduce(s, m("001", ["me", "Welcome"], "irc.test"), 1).state;
  return reduce(s, m("JOIN", ["#dev"], "me!u@h"), 2).state;
}

/** Text made only of IRC codes, whitespace and invisible characters. */
const invisible = fc
  .array(fc.constantFrom("\x02", "\x0f", "\x1f", "\x03", "\x0304", "\x0304,12", " ", "\t", "\u200b", "\u200e", "\u202e", "\x7f"), {
    maxLength: 12,
  })
  .map((parts) => parts.join(""));

/** Text with at least one visible character somewhere. No digits: after `\x03` a digit is a colour code. */
const visible = fc
  .tuple(invisible, fc.constantFrom("a", "Z", "é", "👻", "-", "*"), invisible)
  .map(([a, v, b]) => `${a}${v}${b}`);

const kind = fc.constantFrom("PRIVMSG", "NOTICE", "ACTION");

function send(state: ClientState, k: string, text: string): ClientState {
  const msg = k === "ACTION" ? m("PRIVMSG", ["#dev", `\x01ACTION ${text}\x01`], "coder!c@h") : m(k, ["#dev", text], "coder!c@h");
  return reduce(state, msg, 3).state;
}

describe("P4 no empty lines", () => {
  it("P4 a chat line without a visible character is never stored", () => {
    const base = joined();
    const count = base.windows["c:#dev"]?.lines.length ?? 0;
    fc.assert(
      fc.property(kind, invisible, (k, text) => {
        expect(hasVisibleText(text)).toBe(false);
        expect(send(base, k, text).windows["c:#dev"]?.lines.length).toBe(count);
      }),
      { numRuns: 200 },
    );
  });

  it("P4 a chat line with a visible character is stored", () => {
    const base = joined();
    const count = base.windows["c:#dev"]?.lines.length ?? 0;
    fc.assert(
      fc.property(kind, visible, (k, text) => {
        expect(send(base, k, text).windows["c:#dev"]?.lines.length).toBe(count + 1);
      }),
      { numRuns: 200 },
    );
  });
});
