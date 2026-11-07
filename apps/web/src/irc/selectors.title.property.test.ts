import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { initialState } from "./reducer.js";
import { nullRecord } from "./record.js";
import { titleOf } from "./selectors.js";
import type { ClientState, Window } from "./types.js";

// Feature: web-client-polish, Property 1: Title derivation
// **Validates: Requirements 1.2, 1.3, 1.4, 1.5**

const word = fc.stringMatching(/^[A-Za-z0-9]{1,8}$/);
const modesArb = fc.oneof(
  fc.constantFrom("", "+"),
  fc.stringMatching(/^[a-z]{1,5}$/).map((f) => `+${f}`),
);
const topicArb = fc.option(word, { nil: undefined });
const hostArb = word.map((h) => `${h}.example`);
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;

function stateWith(w: Window | undefined, userModes: string, nick: string): ClientState {
  const base = initialState(nick);
  if (w === undefined) return { ...base, userModes };
  const windows = nullRecord<Window>();
  Object.assign(windows, base.windows, { [w.key]: w });
  return { ...base, userModes, windows, activeKey: w.key };
}

describe("P1 title derivation", () => {
  it("P1 channel title: modes and topic appear only when set", () => {
    fc.assert(
      fc.property(word, modesArb, topicArb, hostArb, (name, modes, topic, host) => {
        const w: Window = {
          key: `c:#${name}`,
          kind: "channel",
          name: `#${name}`,
          lines: [],
          unread: false,
          mentioned: false,
          modes,
          ...(topic === undefined ? {} : { topic }),
        };
        const t = titleOf(stateWith(w, "", "alice"), host);
        expect(t.startsWith("Séance — [")).toBe(true);
        expect(t.endsWith("]")).toBe(true);
        const hasModes = modes !== "" && modes !== "+";
        expect(t.includes(`(${modes})`)).toBe(hasModes);
        expect(t.includes("(")).toBe(hasModes);
        expect(t.includes(`: ${topic ?? ""}`)).toBe(topic !== undefined);
        expect(t.includes(": ")).toBe(topic !== undefined);
      }),
    );
  });

  it("P1 status title: user modes shown only when set", () => {
    fc.assert(
      fc.property(word, modesArb, hostArb, (nick, modes, host) => {
        const t = titleOf(stateWith(undefined, modes, nick), host);
        expect(t.startsWith("Séance — [")).toBe(true);
        expect(t.endsWith("]")).toBe(true);
        expect(t.includes("(")).toBe(modes !== "" && modes !== "+");
      }),
    );
  });

  it("P1 never contains a control character, whatever the topic, modes or host", () => {
    const anyText = fc.string({ unit: "binary", maxLength: 40 });
    fc.assert(
      fc.property(anyText, anyText, anyText, fc.boolean(), (topic, modes, host, channelWindow) => {
        const w: Window = {
          key: "c:#x",
          kind: "channel",
          name: "#x",
          lines: [],
          unread: false,
          mentioned: false,
          modes,
          topic,
        };
        const t = titleOf(stateWith(channelWindow ? w : undefined, modes, "alice"), host);
        expect(CONTROL.test(t)).toBe(false);
        expect(t.startsWith("Séance — [")).toBe(true);
        expect(t.endsWith("]")).toBe(true);
      }),
    );
  });
});
