import { describe, expect, it } from "vitest";
import { Numerics, irc_lower, isValidChannel, isValidNick } from "../src/index.js";

describe("irc_lower", () => {
  it("folds letters and rfc1459 specials", () => {
    expect(irc_lower("Nick[A]\\~")).toBe("nick{a}|^");
  });

  it("is idempotent and treats [ and { as equal", () => {
    expect(irc_lower(irc_lower("A[B"))).toBe(irc_lower("A[B"));
    expect(irc_lower("a[")).toBe(irc_lower("A{"));
  });
});

describe("isValidNick", () => {
  it("accepts valid nicks", () => {
    for (const n of ["a", "Coder", "x-1", "a[b]\\`^{}_", "a".repeat(30)]) {
      expect(isValidNick(n)).toBe(true);
    }
  });

  it("rejects invalid nicks", () => {
    for (const n of ["", "1abc", "-a", "a b", "a,b", "a".repeat(31), "a#b", "é"]) {
      expect(isValidNick(n)).toBe(false);
    }
  });
});

describe("isValidChannel", () => {
  it("accepts valid channels", () => {
    expect(isValidChannel("#fix-bug-123")).toBe(true);
  });

  it("rejects invalid channels", () => {
    for (const c of ["", "#", "foo", "#a b", "#a,b", "#a\x07b", `#${"a".repeat(60)}`]) {
      expect(isValidChannel(c)).toBe(false);
    }
  });
});

describe("Numerics", () => {
  it("exposes three-digit codes", () => {
    expect(Numerics.RPL_WELCOME).toBe("001");
    expect(Numerics.ERR_NICKNAMEINUSE).toBe("433");
    expect(Numerics.RPL_WHOISIDLE).toBe("317");
    expect(Numerics.RPL_WHOISSPECIAL).toBe("320");
    for (const v of Object.values(Numerics)) expect(v).toMatch(/^\d{3}$/);
  });
});
