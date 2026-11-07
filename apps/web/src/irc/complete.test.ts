import { describe, expect, it } from "vitest";
import { completeNick } from "./complete.js";

const nicks = ["coder", "Cody", "reviewer", "[Bot]"] as const;

describe("completeNick", () => {
  it("completes a partial word and appends ': ' at the start of the line", () => {
    const r = completeNick("rev", 3, nicks, null);
    expect(r.input).toBe("reviewer: ");
    expect(r.caret).toBe(10);
  });

  it("does not append the suffix mid-line and keeps text after the caret", () => {
    const r = completeNick("hi rev now", 6, nicks, null);
    expect(r.input).toBe("hi reviewer now");
    expect(r.caret).toBe(11);
  });

  it("matches case-insensitively with rfc1459 case-mapping", () => {
    expect(completeNick("hi {b", 5, nicks, null).input).toBe("hi [Bot]");
  });

  it("cycles through matches on repeated calls and wraps around", () => {
    const a = completeNick("co", 2, nicks, null);
    expect(a.input).toBe("coder: ");
    const b = completeNick(a.input, a.caret, nicks, a.cycle);
    expect(b.input).toBe("Cody: ");
    const c = completeNick(b.input, b.caret, nicks, b.cycle);
    expect(c.input).toBe("coder: ");
  });

  it("starts a fresh completion when the input changed since the last cycle", () => {
    const a = completeNick("hi co", 5, nicks, null);
    const r = completeNick("hi rev", 6, nicks, a.cycle);
    expect(r.input).toBe("hi reviewer");
  });

  it("returns the input unchanged when nothing matches or the word is empty", () => {
    expect(completeNick("zzz", 3, nicks, null)).toEqual({ input: "zzz", caret: 3, cycle: null });
    expect(completeNick("hi ", 3, nicks, null).cycle).toBeNull();
  });

  it("does not mutate its inputs", () => {
    const list = ["coder", "Cody"];
    const copy = [...list];
    const a = completeNick("co", 2, list, null);
    const snapshot = JSON.stringify(a);
    completeNick(a.input, a.caret, list, a.cycle);
    expect(list).toEqual(copy);
    expect(JSON.stringify(a)).toBe(snapshot);
  });
});
