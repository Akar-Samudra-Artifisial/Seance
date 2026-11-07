import { describe, expect, it } from "vitest";
import { parseInput, utf8Length } from "./command-parser.js";
import type { InputContext } from "./command-parser.js";

const channel: InputContext = { ownNick: "me", active: { kind: "channel", target: "#Ghosts" } };
const query: InputContext = { ownNick: "me", active: { kind: "query", target: "coder" } };
const status: InputContext = { ownNick: "me", active: { kind: "status", target: "" } };

describe("parseInput", () => {
  it("sends plain text as PRIVMSG to a channel with an echo", () => {
    expect(parseInput("hello", channel)).toEqual({
      kind: "send",
      messages: [{ command: "PRIVMSG", params: ["#Ghosts", "hello"] }],
      echo: [{ target: "#Ghosts", text: "hello" }],
    });
  });

  it("sends plain text to a query window", () => {
    const r = parseInput("hi", query);
    expect(r.kind === "send" && r.messages[0]).toEqual({ command: "PRIVMSG", params: ["coder", "hi"] });
  });

  it("shows a local line in the Status_Window and sends nothing", () => {
    const r = parseInput("hello", status);
    expect(r.kind).toBe("local");
    if (r.kind === "local" && r.action.type === "status-line") {
      expect(r.action.text.toLowerCase()).toContain("no channel or query is active");
    }
  });

  it("turns //text into PRIVMSG with /text", () => {
    const r = parseInput("//shrug", channel);
    expect(r.kind === "send" && r.messages[0]?.params[1]).toBe("/shrug");
  });

  it("builds JOIN, prepending # when missing and keeping a key", () => {
    expect(parseInput("/join ghosts", status)).toMatchObject({
      kind: "send",
      messages: [{ command: "JOIN", params: ["#ghosts"] }],
    });
    expect(parseInput("/JOIN #a secret", status)).toMatchObject({
      messages: [{ command: "JOIN", params: ["#a", "secret"] }],
    });
  });

  it("reports usage for /join without a channel", () => {
    expect(parseInput("/join", channel).kind).toBe("error");
  });

  it("rejects a line over 512 bytes including CRLF", () => {
    expect(parseInput("x".repeat(600), channel).kind).toBe("error");
    expect(parseInput("é".repeat(300), channel).kind).toBe("error");
  });
});

function msgs(text: string, ctx: InputContext): readonly { command: string; params: readonly string[] }[] {
  const r = parseInput(text, ctx);
  if (r.kind !== "send") throw new Error(`expected send, got ${r.kind}`);
  return r.messages;
}

describe("slash commands", () => {
  it("builds the listed commands in upper case", () => {
    expect(msgs("/part bye now", channel)).toEqual([{ command: "PART", params: ["#Ghosts", "bye now"] }]);
    expect(msgs("/part #x bye", channel)).toEqual([{ command: "PART", params: ["#x", "bye"] }]);
    expect(msgs("/msg bob hello there", channel)).toEqual([{ command: "PRIVMSG", params: ["bob", "hello there"] }]);
    expect(msgs("/topic", channel)).toEqual([{ command: "TOPIC", params: ["#Ghosts"] }]);
    expect(msgs("/topic new topic", channel)).toEqual([{ command: "TOPIC", params: ["#Ghosts", "new topic"] }]);
    expect(msgs("/invite bob", channel)).toEqual([{ command: "INVITE", params: ["bob", "#Ghosts"] }]);
    expect(msgs("/kick bob go away", channel)).toEqual([{ command: "KICK", params: ["#Ghosts", "bob", "go away"] }]);
    expect(msgs("/mode #a +o bob", status)).toEqual([{ command: "MODE", params: ["#a", "+o", "bob"] }]);
    expect(msgs("/whois bob", status)).toEqual([{ command: "WHOIS", params: ["bob"] }]);
    expect(msgs("/names", channel)).toEqual([{ command: "NAMES", params: ["#Ghosts"] }]);
    expect(msgs("/list", status)).toEqual([{ command: "LIST", params: [] }]);
    expect(msgs("/away gone fishing", status)).toEqual([{ command: "AWAY", params: ["gone fishing"] }]);
    expect(msgs("/away", status)).toEqual([{ command: "AWAY", params: [] }]);
    expect(msgs("/nick neo", status)).toEqual([{ command: "NICK", params: ["neo"] }]);
    expect(msgs("/quit so long", status)).toEqual([{ command: "QUIT", params: ["so long"] }]);
  });

  it("wraps /me as a CTCP ACTION", () => {
    expect(msgs("/me waves", channel)).toEqual([{ command: "PRIVMSG", params: ["#Ghosts", "\x01ACTION waves\x01"] }]);
  });

  it("handles /query with and without text", () => {
    expect(parseInput("/query bob", channel)).toEqual({ kind: "local", action: { type: "open-query", nick: "bob" } });
    expect(parseInput("/query bob hi", channel)).toMatchObject({
      kind: "send",
      messages: [{ command: "PRIVMSG", params: ["bob", "hi"] }],
      openQuery: "bob",
    });
  });

  it("reports usage for missing arguments and missing channel", () => {
    for (const line of ["/msg bob", "/whois", "/nick", "/me", "/query", "/kick bob", "/part", "/mode"]) {
      expect(parseInput(line, status).kind).toBe("error");
    }
  });

  it("passes unknown commands through as raw lines with an upper-case name", () => {
    expect(msgs("/who #a o", channel)).toEqual([{ command: "WHO", params: ["#a", "o"] }]);
  });

  it("refuses NUL and multi-line commands", () => {
    expect(parseInput("hi\0there", channel).kind).toBe("error");
    expect(parseInput("/who a\0b", channel).kind).toBe("error");
    expect(parseInput("/join #a\nhello", channel).kind).toBe("error");
  });

  it("splits multi-line text into one PRIVMSG per line, never as commands", () => {
    expect(msgs("a\r\n\r\n/b\n//c", channel)).toEqual([
      { command: "PRIVMSG", params: ["#Ghosts", "a"] },
      { command: "PRIVMSG", params: ["#Ghosts", "/b"] },
      { command: "PRIVMSG", params: ["#Ghosts", "//c"] },
    ]);
  });

  it("asks for confirmation above 5 lines", () => {
    const r = parseInput("1\n2\n3\n4\n5\n6", channel);
    expect(r).toMatchObject({ kind: "confirm-paste", target: "#Ghosts" });
  });
});

describe("utf8Length", () => {
  it("counts bytes, not characters", () => {
    expect(utf8Length("aé€😀")).toBe(1 + 2 + 3 + 4);
  });
});

describe("command defaults from the Active_Window", () => {
  it("uses the active channel for /part /topic /invite /kick /names", () => {
    expect(msgs("/part", channel)).toEqual([{ command: "PART", params: ["#Ghosts"] }]);
    expect(msgs("/topic", channel)).toEqual([{ command: "TOPIC", params: ["#Ghosts"] }]);
    expect(msgs("/invite bob", channel)).toEqual([{ command: "INVITE", params: ["bob", "#Ghosts"] }]);
    expect(msgs("/kick bob", channel)).toEqual([{ command: "KICK", params: ["#Ghosts", "bob"] }]);
    expect(msgs("/names", channel)).toEqual([{ command: "NAMES", params: ["#Ghosts"] }]);
  });

  it("prefers an explicit channel over the active one", () => {
    expect(msgs("/topic #x hello world", channel)).toEqual([{ command: "TOPIC", params: ["#x", "hello world"] }]);
    expect(msgs("/invite bob #x", channel)).toEqual([{ command: "INVITE", params: ["bob", "#x"] }]);
    expect(msgs("/names #x", channel)).toEqual([{ command: "NAMES", params: ["#x"] }]);
  });

  it("has no channel default in query and status windows", () => {
    for (const ctx of [query, status]) {
      for (const line of ["/part", "/topic", "/invite bob", "/kick bob"]) {
        expect(parseInput(line, ctx).kind).toBe("error");
      }
    }
    expect(msgs("/names", status)).toEqual([{ command: "NAMES", params: [] }]);
    expect(msgs("/invite bob #x", status)).toEqual([{ command: "INVITE", params: ["bob", "#x"] }]);
  });
});

describe("command details", () => {
  it("accepts commands case-insensitively", () => {
    expect(msgs("/NICK neo", status)).toEqual([{ command: "NICK", params: ["neo"] }]);
    expect(msgs("/WhoIs bob", status)).toEqual([{ command: "WHOIS", params: ["bob"] }]);
  });

  it("prepends # to /join only when missing", () => {
    expect(msgs("/join #a", status)).toEqual([{ command: "JOIN", params: ["#a"] }]);
    expect(msgs("/join a", status)).toEqual([{ command: "JOIN", params: ["#a"] }]);
  });

  it("builds /msg to a channel without opening a query, and to a nick with one", () => {
    const toChannel = parseInput("/msg #a hi", status);
    expect(toChannel).toMatchObject({ kind: "send", echo: [{ target: "#a", text: "hi" }] });
    expect(toChannel.kind === "send" && toChannel.openQuery).toBeUndefined();
    expect(parseInput("/msg bob hi", status)).toMatchObject({ kind: "send", openQuery: "bob" });
  });

  it("builds /mode for a user target, /list with arguments and bare /quit", () => {
    expect(msgs("/mode me +i", status)).toEqual([{ command: "MODE", params: ["me", "+i"] }]);
    expect(msgs("/list #a,#b", status)).toEqual([{ command: "LIST", params: ["#a,#b"] }]);
    expect(msgs("/quit", status)).toEqual([{ command: "QUIT", params: [] }]);
  });

  it("echoes /me with the CTCP wrapper to the active target, also in a query", () => {
    expect(parseInput("/me waves", query)).toMatchObject({
      kind: "send",
      messages: [{ command: "PRIVMSG", params: ["coder", "\x01ACTION waves\x01"] }],
      echo: [{ target: "coder", text: "\x01ACTION waves\x01" }],
    });
  });

  it("shows a local status line for /me and //text in the Status_Window", () => {
    expect(parseInput("/me waves", status).kind).toBe("local");
    expect(parseInput("//shrug", status).kind).toBe("local");
  });

  it("opens a query locally for /query without text and sends nothing", () => {
    const r = parseInput("/query bob", status);
    expect(r).toEqual({ kind: "local", action: { type: "open-query", nick: "bob" } });
  });

  it("echoes //text with a single leading slash", () => {
    expect(parseInput("//a b", channel)).toMatchObject({
      kind: "send",
      messages: [{ command: "PRIVMSG", params: ["#Ghosts", "/a b"] }],
      echo: [{ target: "#Ghosts", text: "/a b" }],
    });
  });

  it("rejects an empty command", () => {
    expect(parseInput("/", channel).kind).toBe("error");
  });
});

describe("usage errors per command", () => {
  const cases: readonly (readonly [string, string, InputContext])[] = [
    ["join", "/join", channel],
    ["msg", "/msg", channel],
    ["msg", "/msg bob", channel],
    ["msg", "/msg bob   ", channel],
    ["part", "/part", status],
    ["topic", "/topic", query],
    ["invite", "/invite", channel],
    ["invite", "/invite bob", status],
    ["kick", "/kick", channel],
    ["kick", "/kick bob", query],
    ["mode", "/mode", channel],
    ["whois", "/whois", channel],
    ["nick", "/nick", channel],
    ["me", "/me", channel],
    ["me", "/me   ", channel],
    ["query", "/query", channel],
  ];
  it.each(cases)("/%s reports usage for %j", (name, line, ctx) => {
    const r = parseInput(line, ctx);
    expect(r.kind).toBe("error");
    expect(r.kind === "error" && r.text).toContain(`/${name}: usage:`);
  });
});

describe("refusals", () => {
  it("refuses NUL anywhere, including in //text, commands and multi-line input", () => {
    for (const line of ["\0", "//a\0", "/join #a\0", "/me hi\0", "a\nb\0c", "/who a\0b"]) {
      const r = parseInput(line, channel);
      expect(r.kind).toBe("error");
    }
  });

  it("refuses a Raw_Command containing CR, LF or NUL", () => {
    for (const line of ["/who a\rPRIVMSG #x :boo", "/who a\nPRIVMSG #x :boo", "/who a\0b", "/who\nPRIVMSG #x :boo"]) {
      expect(parseInput(line, channel).kind).toBe("error");
    }
  });

  it("refuses a multi-line command for known commands too", () => {
    for (const line of ["/me waves\nmore", "/part\r\nx", "/nick a\rb"]) {
      expect(parseInput(line, channel)).toEqual({ kind: "error", text: "Commands must be a single line." });
    }
  });
});

describe("paste handling", () => {
  const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line${i + 1}`).join("\n");

  it("sends 1 line with a trailing newline as one PRIVMSG", () => {
    expect(msgs("hello\n", channel)).toEqual([{ command: "PRIVMSG", params: ["#Ghosts", "hello"] }]);
  });

  it.each([2, 3, 4, 5])("sends %i lines as one PRIVMSG each, with echoes", (n) => {
    const r = parseInput(lines(n), channel);
    expect(r.kind).toBe("send");
    if (r.kind !== "send") return;
    expect(r.messages).toHaveLength(n);
    expect(r.echo).toHaveLength(n);
    expect(r.messages[n - 1]).toEqual({ command: "PRIVMSG", params: ["#Ghosts", `line${n}`] });
  });

  it.each([6, 7, 20])("asks for confirmation with all %i lines above 5", (n) => {
    const r = parseInput(lines(n), channel);
    expect(r.kind).toBe("confirm-paste");
    if (r.kind === "confirm-paste") {
      expect(r.lines).toHaveLength(n);
      expect(r.target).toBe("#Ghosts");
    }
  });

  it("pastes to a query target", () => {
    expect(msgs("a\nb", query)).toEqual([
      { command: "PRIVMSG", params: ["coder", "a"] },
      { command: "PRIVMSG", params: ["coder", "b"] },
    ]);
  });

  it("shows a local status line for a paste in the Status_Window", () => {
    expect(parseInput("a\nb", status).kind).toBe("local");
  });
});
