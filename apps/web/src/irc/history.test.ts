import { describe, expect, it } from "vitest";
import { EMPTY_HISTORY, navigate, pushHistory, type History } from "./history.js";
import { HISTORY_MAX } from "./types.js";

function pushAll(entries: readonly string[]): History {
  return entries.reduce(pushHistory, EMPTY_HISTORY);
}

describe("pushHistory", () => {
  it("appends entries oldest first and sits at the draft position", () => {
    const h = pushAll(["a", "b"]);
    expect(h.entries).toEqual(["a", "b"]);
    expect(h.position).toBe(2);
  });

  it("skips empty entries and consecutive duplicates", () => {
    expect(pushAll(["a", "", "a", "b", "a"]).entries).toEqual(["a", "b", "a"]);
  });

  it("keeps only the newest 100 entries", () => {
    const h = pushAll(Array.from({ length: HISTORY_MAX + 5 }, (_, i) => `m${i}`));
    expect(h.entries).toHaveLength(HISTORY_MAX);
    expect(h.entries[0]).toBe("m5");
    expect(h.entries[HISTORY_MAX - 1]).toBe(`m${HISTORY_MAX + 4}`);
  });

  it("does not mutate its input", () => {
    const h = pushAll(["a"]);
    const copy = JSON.stringify(h);
    pushHistory(h, "b");
    expect(JSON.stringify(h)).toBe(copy);
  });
});

describe("navigate", () => {
  it("Up returns the most recent entry and saves the draft", () => {
    const r = navigate(pushAll(["a", "b"]), "up", "typing");
    expect(r.text).toBe("b");
    expect(r.history.draft).toBe("typing");
  });

  it("Up stops at the oldest entry", () => {
    let h = pushAll(["a", "b"]);
    let text = "";
    for (let i = 0; i < 5; i++) ({ history: h, text } = navigate(h, "up", text));
    expect(text).toBe("a");
    expect(h.position).toBe(0);
  });

  it("Down walks forward and restores the draft past the newest entry", () => {
    let r = navigate(pushAll(["a", "b"]), "up", "draft");
    r = navigate(r.history, "up", r.text);
    expect(r.text).toBe("a");
    r = navigate(r.history, "down", r.text);
    expect(r.text).toBe("b");
    r = navigate(r.history, "down", r.text);
    expect(r.text).toBe("draft");
    expect(r.history.position).toBe(2);
  });

  it("is a no-op on empty history and Down at the draft position", () => {
    expect(navigate(EMPTY_HISTORY, "up", "x").text).toBe("x");
    expect(navigate(pushAll(["a"]), "down", "x").text).toBe("x");
  });
});
