import { describe, expect, it } from "vitest";
import { memberPrefix, sortMembers } from "./nick-order.js";
import type { Member } from "./types.js";

const m = (nick: string, op = false, voice = false): Member => ({ nick, op, voice });

describe("sortMembers", () => {
  it("groups operators, voiced, others, alphabetical within each", () => {
    const input = [m("zed"), m("bob", false, true), m("Carl", true), m("alice"), m("amy", true, true)];
    expect(sortMembers(input).map((x) => x.nick)).toEqual(["amy", "Carl", "bob", "alice", "zed"]);
  });

  it("uses rfc1459 case-mapping ([ ] \\ ~ fold to { } | ^)", () => {
    const input = [m("a}"), m("a]"), m("A["), m("a|")];
    // "[" folds to "{", "]" to "}", "|" stays; "{" < "|" < "}"
    expect(sortMembers(input).map((x) => x.nick)).toEqual(["A[", "a|", "a}", "a]"]);
  });

  it("returns a new array and leaves the input untouched", () => {
    const input = [m("b"), m("a")];
    const out = sortMembers(input);
    expect(out).not.toBe(input);
    expect(input.map((x) => x.nick)).toEqual(["b", "a"]);
  });

  it("handles an empty list", () => {
    expect(sortMembers([])).toEqual([]);
  });
});

describe("memberPrefix", () => {
  it("returns @ for ops, + for voiced, empty otherwise; @ wins", () => {
    expect(memberPrefix(m("a", true, true))).toBe("@");
    expect(memberPrefix(m("a", true))).toBe("@");
    expect(memberPrefix(m("a", false, true))).toBe("+");
    expect(memberPrefix(m("a"))).toBe("");
  });
});
