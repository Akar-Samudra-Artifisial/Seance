import { describe, expect, it } from "vitest";
import { formatIrc } from "./formatter.js";

describe("formatIrc", () => {
  it("returns no spans for empty input and one plain span otherwise", () => {
    expect(formatIrc("")).toEqual([]);
    expect(formatIrc("hi")).toEqual([{ text: "hi", bold: false, underline: false }]);
  });

  it("maps every colour code 0 to 15, with one or two digits", () => {
    for (let n = 0; n <= 15; n++) {
      const two = String(n).padStart(2, "0");
      expect(formatIrc(`\x03${two}x`)).toEqual([{ text: "x", fg: n, bold: false, underline: false }]);
      expect(formatIrc(`\x03${n}x`)).toEqual([{ text: "x", fg: n, bold: false, underline: false }]);
    }
  });

  it("parses a background pair", () => {
    expect(formatIrc("\x034,12hi")).toEqual([{ text: "hi", fg: 4, bg: 12, bold: false, underline: false }]);
  });

  it("keeps a comma as text when no digit follows", () => {
    expect(formatIrc("\x034,x")).toEqual([{ text: ",x", fg: 4, bold: false, underline: false }]);
  });

  it("bare \\x03 resets colours only", () => {
    const spans = formatIrc("\x02\x034,5a\x03b");
    expect(spans).toEqual([
      { text: "a", fg: 4, bg: 5, bold: true, underline: false },
      { text: "b", bold: true, underline: false },
    ]);
  });

  it("consumes out-of-range digits without colour", () => {
    expect(formatIrc("\x0399x")).toEqual([{ text: "x", bold: false, underline: false }]);
    expect(formatIrc("\x035,99x")).toEqual([{ text: "x", fg: 5, bold: false, underline: false }]);
    expect(formatIrc("\x0316x")).toEqual([{ text: "x", bold: false, underline: false }]);
  });

  it("colours the Fake_Agent reply without showing the colour digits", () => {
    expect(formatIrc("\x0312The veil is thin tonight.\x0F")).toEqual([
      { text: "The veil is thin tonight.", fg: 12, bold: false, underline: false },
    ]);
  });

  it("shows digits that follow a full two-digit colour code (runner wire form of the Fake_Agent reply)", () => {
    // The runner strips the agent's own \x03 and re-wraps with the agent colour (coder = 12),
    // so "\x0312The…" arrives as "\x0312" + "12The…". The second "12" is text.
    expect(formatIrc("\x031212The veil is thin tonight.\x0F")).toEqual([
      { text: "12The veil is thin tonight.", fg: 12, bold: false, underline: false },
    ]);
  });

  it("consumes at most two digits", () => {
    expect(formatIrc("\x03123")).toEqual([{ text: "3", fg: 12, bold: false, underline: false }]);
  });

  it("toggles bold and underline and resets with \\x0f", () => {
    expect(formatIrc("\x02a\x1fb\x02c\x0fd")).toEqual([
      { text: "a", bold: true, underline: false },
      { text: "b", bold: true, underline: true },
      { text: "c", bold: false, underline: true },
      { text: "d", bold: false, underline: false },
    ]);
  });

  it("turns tab into a space and drops other control characters and 0x7f", () => {
    expect(formatIrc("a\tb\x01c\x7fd\x00e\x1b")).toEqual([
      { text: "a bcde", bold: false, underline: false },
    ]);
  });

  it("strips bidi controls and C1 controls", () => {
    const bidi = "\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069";
    const c1 = "\u0080\u0085\u009f";
    expect(formatIrc(`a${bidi}b${c1}c`)).toEqual([{ text: "abc", bold: false, underline: false }]);
    // Neighbours of the ranges stay.
    expect(formatIrc("\u00a0\u202f\u2065\u206a")).toEqual([
      { text: "\u00a0\u202f\u2065\u206a", bold: false, underline: false },
    ]);
  });

  it("emits no span for a string of only codes", () => {
    expect(formatIrc("\x02\x03\x0f\x1f")).toEqual([]);
  });
});
