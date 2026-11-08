import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { batchNames, filterRows, nextSort, parseListRow, sortRows, summarise } from "./channel-list.js";
import type { ListRow } from "./types.js";

const row = (name: string, users: number, topic: string, agents: number | null = null): ListRow => ({
  name,
  users,
  topic,
  agents,
});

describe("parseListRow", () => {
  it("accepts a normal 322", () => {
    expect(parseListRow(["me", "#a", "3", "Fix it"])).toEqual({ name: "#a", users: 3, topic: "Fix it", agents: null });
  });
  it("accepts a missing topic", () => {
    expect(parseListRow(["me", "#a", "0"])?.topic).toBe("");
  });
  it.each([
    [["me", "", "3", "t"]],
    [["me", "#a b", "3", "t"]],
    [["me", "#a", "x", "t"]],
    [["me", "#a", "-1", "t"]],
    [["me", "#a", "1234567890", "t"]],
    [["me", `#${"a".repeat(200)}`, "1", "t"]],
    [["me"]],
  ])("drops %j", (params) => {
    expect(parseListRow(params)).toBeUndefined();
  });
  it("measures the name limit in UTF-8 bytes (review finding 3)", () => {
    // "é" is 2 bytes, "中" 3 bytes, an emoji 4 bytes.
    expect(parseListRow(["me", `#${"é".repeat(99)}`, "1"])?.name).toBeDefined(); // 199 bytes
    expect(parseListRow(["me", `#${"é".repeat(100)}`, "1"])).toBeUndefined(); // 201 bytes, 101 chars
    expect(parseListRow(["me", `#${"中".repeat(66)}`, "1"])).toBeDefined(); // 199 bytes
    expect(parseListRow(["me", `#${"中".repeat(67)}`, "1"])).toBeUndefined(); // 202 bytes, 68 chars
    expect(parseListRow(["me", `#${"\u{1F383}".repeat(50)}`, "1"])).toBeUndefined(); // 201 bytes
  });

  it("P5 every accepted name fits one NAMES line within 512 bytes", () => {
    const nameArb = fc.string({ unit: "grapheme", minLength: 1, maxLength: 220 }).map((s) => `#${s.replace(/[\s,\x00]/g, "x")}`);
    fc.assert(
      fc.property(fc.array(nameArb, { maxLength: 20 }), (names) => {
        const accepted = names.flatMap((n) => {
          const row = parseListRow(["me", n, "1"]);
          return row === undefined ? [] : [row.name];
        });
        for (const b of batchNames(accepted)) {
          // NAMES <list> CRLF must stay within the 512-byte line limit.
          expect(new TextEncoder().encode(`NAMES ${b}\r\n`).length).toBeLessThanOrEqual(512);
        }
      }),
    );
  });

  it("clips an oversized topic", () => {
    expect(parseListRow(["me", "#a", "1", "x".repeat(900)])?.topic).toHaveLength(512);
  });
});

describe("filterRows", () => {
  const rows = [
    row("#fix-bug", 4, "Fix NPE on login", 3),
    row("#docs", 1, "", 0),
    row("#Landing", 3, "\x02Hero\x02 copy", null),
  ];
  it("matches name or topic, case-insensitive, ignoring control codes", () => {
    expect(filterRows(rows, { text: "LANDING", minAgents: 0, hideEmptyTopics: false })).toHaveLength(1);
    expect(filterRows(rows, { text: "hero copy", minAgents: 0, hideEmptyTopics: false })).toHaveLength(1);
    expect(filterRows(rows, { text: "npe", minAgents: 0, hideEmptyTopics: false })[0]?.name).toBe("#fix-bug");
  });
  it("min agents ignores unknown counts", () => {
    const out = filterRows(rows, { text: "", minAgents: 2, hideEmptyTopics: false }).map((r) => r.name);
    expect(out).toEqual(["#fix-bug", "#Landing"]);
  });
  it("hides channels without a topic", () => {
    const out = filterRows(rows, { text: "", minAgents: 0, hideEmptyTopics: true }).map((r) => r.name);
    expect(out).toEqual(["#fix-bug", "#Landing"]);
  });
});

describe("sortRows and nextSort", () => {
  const rows = [row("#b", 2, "x", 1), row("#a", 2, "y", null), row("#c", 9, "z", 3)];
  it("keeps server order without a sort", () => {
    expect(sortRows(rows, undefined)).toBe(rows);
  });
  it("sorts by users and keeps ties in server order", () => {
    expect(sortRows(rows, { column: "users", direction: "asc" }).map((r) => r.name)).toEqual(["#b", "#a", "#c"]);
    expect(sortRows(rows, { column: "users", direction: "desc" }).map((r) => r.name)).toEqual(["#c", "#b", "#a"]);
  });
  it("puts unknown agent counts last in both directions", () => {
    expect(sortRows(rows, { column: "agents", direction: "asc" }).map((r) => r.name)).toEqual(["#b", "#c", "#a"]);
    expect(sortRows(rows, { column: "agents", direction: "desc" }).map((r) => r.name)).toEqual(["#c", "#b", "#a"]);
  });
  it("cycles asc, desc, none", () => {
    const a = nextSort(undefined, "topic");
    expect(a).toEqual({ column: "topic", direction: "asc" });
    const d = nextSort(a, "topic");
    expect(d).toEqual({ column: "topic", direction: "desc" });
    expect(nextSort(d, "topic")).toBeUndefined();
    expect(nextSort(d, "users")).toEqual({ column: "users", direction: "asc" });
  });
});

describe("summarise", () => {
  it("counts channels and known agents", () => {
    expect(summarise([row("#a", 1, "", 2), row("#b", 1, "", null)])).toEqual({ channels: 2, agents: 2 });
  });
});

const nameArb = fc.stringMatching(/^#[a-z0-9\u00e9\u4e2d]{1,40}$/);
const rowArb = fc.record({
  name: nameArb,
  users: fc.nat(1000),
  topic: fc.string({ maxLength: 40 }),
  agents: fc.option(fc.nat(20), { nil: null }),
});
const filterArb = fc.record({ text: fc.string({ maxLength: 6 }), minAgents: fc.nat(5), hideEmptyTopics: fc.boolean() });

describe("channel list properties", () => {
  it("P1 filter is a subset and idempotent", () => {
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 30 }), filterArb, (rows, filter) => {
        const once = filterRows(rows, filter);
        expect(once.every((r) => rows.includes(r))).toBe(true);
        expect(filterRows(once, filter)).toEqual(once);
      }),
    );
  });
  it("P2 sort is a permutation", () => {
    const sortArb = fc.record({
      column: fc.constantFrom("channel", "agents", "users", "topic"),
      direction: fc.constantFrom("asc", "desc"),
    });
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 30 }), sortArb, (rows, sort) => {
        const out = sortRows(rows, sort);
        expect(out).toHaveLength(rows.length);
        expect([...out].sort((a, b) => (a.name + a.users < b.name + b.users ? -1 : 1))).toEqual(
          [...rows].sort((a, b) => (a.name + a.users < b.name + b.users ? -1 : 1)),
        );
      }),
    );
  });
  it("P4 batches stay within the byte limit and cover every channel in order", () => {
    fc.assert(
      fc.property(fc.array(nameArb, { maxLength: 80 }), fc.integer({ min: 100, max: 400 }), (names, max) => {
        const batches = batchNames(names, max);
        for (const b of batches) expect(new TextEncoder().encode(`NAMES ${b}`).length).toBeLessThanOrEqual(max);
        expect(batches.flatMap((b) => b.split(","))).toEqual(names);
      }),
    );
  });
});
