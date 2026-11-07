import { describe, expect, it } from "vitest";
import { PASTE_LIMITS, splitPaste } from "./paste.js";
import { PASTE_INTERVAL_MS, PASTE_MAX_LINES } from "./types.js";

describe("splitPaste", () => {
  it("splits on CRLF, LF and CR", () => {
    expect(splitPaste("a\r\nb\nc\rd")).toEqual(["a", "b", "c", "d"]);
  });

  it("discards empty lines", () => {
    expect(splitPaste("\n\na\r\n\r\n\rb\n")).toEqual(["a", "b"]);
  });

  it("keeps line text unchanged, including slashes and spaces", () => {
    expect(splitPaste("/join #x\n  indented ")).toEqual(["/join #x", "  indented "]);
  });

  it("returns no lines for empty or break-only input", () => {
    expect(splitPaste("")).toEqual([]);
    expect(splitPaste("\r\n\n\r")).toEqual([]);
  });

  it("returns a single line when there is no break", () => {
    expect(splitPaste("hello")).toEqual(["hello"]);
  });
});

describe("PASTE_LIMITS", () => {
  it("uses the constants from types.ts", () => {
    expect(PASTE_LIMITS.maxLines).toBe(PASTE_MAX_LINES);
    expect(PASTE_LIMITS.intervalMs).toBe(PASTE_INTERVAL_MS);
  });
});
