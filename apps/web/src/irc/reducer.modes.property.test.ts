import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyChannelModeChange, applyFlagChanges } from "./reducer.modes.js";
import { initialState, reduce } from "./reducer.js";
import { openWindow } from "./reducer.route.js";
import type { ClientState } from "./types.js";

// Feature: web-client-polish, Property 5: Mode tracking
// **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5**

const CHANNEL = "#dev";
const KEY = "c:#dev";
const NOW_MS = 1_700_000_000_000;
const WITH_ARGUMENT = new Set(["o", "v", "b", "k", "l", "e", "I"]);

/** Reference model: a set of letters, `+`/`-` toggle per letter, argument flags never stored. */
function referenceStep(flags: ReadonlySet<string>, modeString: string): ReadonlySet<string> {
  if (!modeString.startsWith("+") && !modeString.startsWith("-")) return flags;
  const next = new Set(flags);
  let adding = true;
  for (const ch of modeString) {
    if (ch === "+") adding = true;
    else if (ch === "-") adding = false;
    else if (/^[A-Za-z]$/.test(ch) && !WITH_ARGUMENT.has(ch)) {
      if (adding) next.add(ch);
      else next.delete(ch);
    }
  }
  return next;
}

const renderReference = (flags: ReadonlySet<string>): string =>
  flags.size === 0 ? "" : `+${[...flags].sort().join("")}`;

/** Mode strings: mostly well-formed, with argument flags, digits, spaces and stray signs mixed in. */
const modeStringArb = fc
  .array(fc.constantFrom(..."+-+-mntislkovbeIpazAZ19 :,é"), { minLength: 0, maxLength: 12 })
  .map((chars) => chars.join(""));

const sequenceArb = fc.array(modeStringArb, { minLength: 0, maxLength: 10 });

function baseState(): ClientState {
  return openWindow(initialState("me"), "channel", CHANNEL, false);
}

function modesOf(state: ClientState): string {
  return state.windows[KEY]?.modes ?? "";
}

describe("P5 mode tracking matches reference model", () => {
  it("applyChannelModeChange equals the reference model over any MODE sequence", () => {
    fc.assert(
      fc.property(sequenceArb, (sequence) => {
        let state = baseState();
        let model: ReadonlySet<string> = new Set();
        for (const modeString of sequence) {
          state = applyChannelModeChange(state, CHANNEL, modeString);
          model = referenceStep(model, modeString);
          const modes = modesOf(state);
          expect(modes).toBe(renderReference(model));
          // Only letters of flags without arguments, sorted, no duplicates.
          const letters = modes.slice(1).split("");
          expect(letters.every((l) => /^[A-Za-z]$/.test(l) && !WITH_ARGUMENT.has(l))).toBe(true);
          expect(letters).toEqual([...new Set(letters)].sort());
        }
      }),
      { numRuns: 200 },
    );
  });

  it("channel MODE messages through the reducer match the reference model and never throw", () => {
    fc.assert(
      fc.property(sequenceArb, (sequence) => {
        let state = baseState();
        let model: ReadonlySet<string> = new Set();
        for (const modeString of sequence) {
          state = reduce(
            state,
            {
              prefix: "op!u@h",
              command: "MODE",
              params: [CHANNEL, modeString],
            },
            NOW_MS,
          ).state;
          model = referenceStep(model, modeString);
        }
        expect(modesOf(state)).toBe(renderReference(model));
      }),
      { numRuns: 100 },
    );
  });

  it("malformed input never throws", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.string({ maxLength: 40 }), (current, modeString) => {
        expect(() => applyFlagChanges(current, modeString)).not.toThrow();
        expect(() => applyChannelModeChange(baseState(), CHANNEL, modeString)).not.toThrow();
        expect(() => applyChannelModeChange(baseState(), "#missing", modeString)).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });
});
