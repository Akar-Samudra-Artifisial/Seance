import { describe, expect, it } from "vitest";
import { serialize } from "../src/index.js";

describe("serialize", () => {
  it("emits a bare command with CRLF", () => {
    expect(serialize({ command: "PING", params: [] })).toBe("PING\r\n");
  });

  it("emits prefix, command and params separated by single spaces", () => {
    expect(
      serialize({ prefix: "nick!u@h", command: "MODE", params: ["#c", "+o", "bob"] }),
    ).toBe(":nick!u@h MODE #c +o bob\r\n");
  });

  it("upper-cases the command", () => {
    expect(serialize({ command: "privmsg", params: ["#c", "hi"] })).toBe(
      "PRIVMSG #c hi\r\n",
    );
  });

  it("adds ':' to a last param containing a space", () => {
    expect(serialize({ command: "PRIVMSG", params: ["#c", "hello world"] })).toBe(
      "PRIVMSG #c :hello world\r\n",
    );
  });

  it("adds ':' to a last param starting with ':'", () => {
    expect(serialize({ command: "PRIVMSG", params: ["#c", ":)"] })).toBe(
      "PRIVMSG #c ::)\r\n",
    );
  });

  it("adds ':' to an empty last param", () => {
    expect(serialize({ command: "TOPIC", params: ["#c", ""] })).toBe(
      "TOPIC #c :\r\n",
    );
  });

  it("omits ':' for a plain last param", () => {
    expect(serialize({ command: "JOIN", params: ["#c"] })).toBe("JOIN #c\r\n");
  });

  it("accepts a numeric command", () => {
    expect(serialize({ prefix: "srv", command: "001", params: ["me", "Welcome"] })).toBe(
      ":srv 001 me Welcome\r\n",
    );
  });

  it("ends in exactly one CRLF", () => {
    const line = serialize({ command: "PRIVMSG", params: ["#c", "a b"] });
    expect(line.endsWith("\r\n")).toBe(true);
    expect(line.slice(0, -2)).not.toMatch(/[\r\n]/);
  });

  describe("512-byte limit", () => {
    // "PRIVMSG #c :" is 12 bytes, CRLF is 2, leaving 498 for the text.
    const build = (text: string) => ({ command: "PRIVMSG", params: ["#c", text] });

    it("accepts exactly 512 bytes", () => {
      const line = serialize(build(" " + "a".repeat(497)));
      expect(new TextEncoder().encode(line).length).toBe(512);
    });

    it("rejects 513 bytes", () => {
      expect(() => serialize(build(" " + "a".repeat(498)))).toThrow(/513 UTF-8 bytes/);
    });

    it("measures bytes, not characters", () => {
      // 2 spaces + 248 two-byte chars = 498 bytes (ok), only 250 characters.
      const ok = serialize(build("  " + "é".repeat(248)));
      expect(new TextEncoder().encode(ok).length).toBe(512);
      expect(ok.length).toBeLessThan(512);
      // 167 three-byte chars = 501 bytes (too long) yet only 167 characters.
      expect(() => serialize(build(" " + "€".repeat(167)))).toThrow(/exceeds the 512-byte limit/);
    });
  });

  describe("rejects unsafe messages", () => {
    it.each(["\r", "\n", "\0"])("param containing %j", (ch) => {
      expect(() => serialize({ command: "PRIVMSG", params: ["#c", `a${ch}b`] })).toThrow(
        /CR, LF or NUL/,
      );
      expect(() => serialize({ command: "PRIVMSG", params: [`a${ch}b`, "x"] })).toThrow(
        /CR, LF or NUL/,
      );
    });

    it("non-last param with a space", () => {
      expect(() => serialize({ command: "MODE", params: ["a b", "x"] })).toThrow(
        /non-last param 0/,
      );
    });

    it("non-last param starting with ':'", () => {
      expect(() => serialize({ command: "MODE", params: [":a", "x"] })).toThrow(
        /non-last param 0/,
      );
    });

    it("empty non-last param", () => {
      expect(() => serialize({ command: "MODE", params: ["", "x"] })).toThrow(
        /non-last param 0/,
      );
    });

    it("more than 15 params", () => {
      const params = Array.from({ length: 16 }, () => "x");
      expect(() => serialize({ command: "X", params })).toThrow(/16 params/);
      expect(serialize({ command: "X", params: params.slice(0, 15) })).toMatch(/\r\n$/);
    });

    it("bad prefix or command", () => {
      expect(() => serialize({ prefix: "", command: "X", params: [] })).toThrow(/prefix/);
      expect(() => serialize({ prefix: "a b", command: "X", params: [] })).toThrow(/prefix/);
      expect(() => serialize({ command: "BAD CMD", params: [] })).toThrow(/command/);
    });
  });
});
