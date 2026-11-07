import { describe, expect, it } from "vitest";
import { isMention } from "./mention.js";

describe("isMention", () => {
  it("matches at start, middle, end and whole text", () => {
    expect(isMention("alice", "alice")).toBe(true);
    expect(isMention("alice: hi", "alice")).toBe(true);
    expect(isMention("hi alice!", "alice")).toBe(true);
    expect(isMention("hey, alice", "alice")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isMention("hello ALICE", "alice")).toBe(true);
  });

  it("uses rfc1459 case-mapping for []\\~", () => {
    expect(isMention("ping [a]", "{a}")).toBe(true);
    expect(isMention("ping {a}", "[a]")).toBe(true);
    expect(isMention("ping a\\b", "a|b")).toBe(true);
    expect(isMention("ping a~b", "a^b")).toBe(true);
  });

  it("rejects substrings inside longer words", () => {
    expect(isMention("alice2", "alice")).toBe(false);
    expect(isMention("malice", "alice")).toBe(false);
    expect(isMention("alice_", "alice")).toBe(false);
    expect(isMention("-alice", "alice")).toBe(false);
    expect(isMention("alice[", "alice")).toBe(false);
  });

  it("finds a later match after a rejected one", () => {
    expect(isMention("alice2 alice", "alice")).toBe(true);
  });

  it("treats non-nick punctuation as delimiters", () => {
    expect(isMention("(alice)", "alice")).toBe(true);
    expect(isMention("alice.", "alice")).toBe(true);
    expect(isMention("@alice", "alice")).toBe(true);
  });

  it("returns false for an empty nick or empty text", () => {
    expect(isMention("hi", "")).toBe(false);
    expect(isMention("", "alice")).toBe(false);
  });
});
