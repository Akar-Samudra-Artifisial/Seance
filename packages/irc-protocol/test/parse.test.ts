import { describe, expect, it } from "vitest";
import { isParseError, parse } from "../src/index.js";
import type { IrcMessage, ParseError } from "../src/index.js";

function expectMessage(result: IrcMessage | ParseError): IrcMessage {
  if (isParseError(result)) {
    throw new Error(`expected a message, got parse error: ${result.reason}`);
  }
  return result;
}

function expectError(result: IrcMessage | ParseError): ParseError {
  if (!isParseError(result)) {
    throw new Error(
      `expected a parse error, got message: ${JSON.stringify(result)}`,
    );
  }
  return result;
}

describe("parse", () => {
  it("parses a bare command with no prefix or params", () => {
    const msg = expectMessage(parse("PING"));
    expect(msg).toEqual({ command: "PING", params: [] });
    expect(msg.prefix).toBeUndefined();
  });

  it("uppercases the command", () => {
    expect(expectMessage(parse("privmsg #ch :hi")).command).toBe("PRIVMSG");
    expect(expectMessage(parse("NiCk alice")).command).toBe("NICK");
  });

  it("parses a 3-digit numeric command", () => {
    const msg = expectMessage(parse("433 * alice :Nickname is already in use"));
    expect(msg.command).toBe("433");
    expect(msg.params).toEqual(["*", "alice", "Nickname is already in use"]);
  });

  it("parses an optional prefix", () => {
    const msg = expectMessage(parse(":nick!user@host PRIVMSG #ch :hello"));
    expect(msg.prefix).toBe("nick!user@host");
    expect(msg.command).toBe("PRIVMSG");
    expect(msg.params).toEqual(["#ch", "hello"]);
  });

  it("keeps the trailing parameter intact including spaces", () => {
    const msg = expectMessage(parse("PRIVMSG #ch :hello there world"));
    expect(msg.params).toEqual(["#ch", "hello there world"]);
  });

  it("treats a trailing parameter beginning with ':' as the last param", () => {
    const msg = expectMessage(parse("PRIVMSG #ch :: starts with a colon"));
    expect(msg.params).toEqual(["#ch", ": starts with a colon"]);
  });

  it("allows an empty trailing parameter", () => {
    const msg = expectMessage(parse("PRIVMSG #ch :"));
    expect(msg.params).toEqual(["#ch", ""]);
  });

  it("parses multiple middle parameters", () => {
    const msg = expectMessage(parse("MODE #ch +o alice"));
    expect(msg.params).toEqual(["#ch", "+o", "alice"]);
  });

  it("strips a trailing CRLF", () => {
    const msg = expectMessage(parse("PRIVMSG #ch :hi\r\n"));
    expect(msg.params).toEqual(["#ch", "hi"]);
  });

  it("tolerates a bare LF line terminator", () => {
    const msg = expectMessage(parse("PRIVMSG #ch :hi\n"));
    expect(msg.params).toEqual(["#ch", "hi"]);
  });

  it("collapses repeated spaces between tokens", () => {
    const msg = expectMessage(parse("PRIVMSG   #ch    :hi"));
    expect(msg.command).toBe("PRIVMSG");
    expect(msg.params).toEqual(["#ch", "hi"]);
  });

  it("preserves a multi-byte UTF-8 trailing parameter", () => {
    const msg = expectMessage(parse("PRIVMSG #ch :héllo 👻 wörld"));
    expect(msg.params).toEqual(["#ch", "héllo 👻 wörld"]);
  });

  it("accepts exactly 15 parameters", () => {
    const middle = Array.from({ length: 14 }, (_, i) => `p${i}`).join(" ");
    const msg = expectMessage(parse(`CMD ${middle} :trailing`));
    expect(msg.params).toHaveLength(15);
  });

  describe("parse errors (never throws)", () => {
    it("returns a ParseError for an empty line", () => {
      expect(expectError(parse("")).kind).toBe("parse-error");
    });

    it("returns a ParseError for a line that is only CRLF", () => {
      expect(isParseError(parse("\r\n"))).toBe(true);
    });

    it("returns a ParseError for a prefix with no command", () => {
      expect(isParseError(parse(":nick!user@host"))).toBe(true);
    });

    it("returns a ParseError for an empty prefix", () => {
      expect(isParseError(parse(": PRIVMSG #ch"))).toBe(true);
    });

    it("returns a ParseError for a command with digits mixed in", () => {
      expect(isParseError(parse("PR1VMSG #ch"))).toBe(true);
    });

    it("returns a ParseError for a 4-digit numeric", () => {
      expect(isParseError(parse("4331 #ch"))).toBe(true);
    });

    it("returns a ParseError for more than 15 parameters", () => {
      // 16 space-separated middle params, none trailing.
      const params = Array.from({ length: 16 }, (_, i) => `p${i}`).join(" ");
      expect(isParseError(parse(`CMD ${params}`))).toBe(true);
    });
  });
});
