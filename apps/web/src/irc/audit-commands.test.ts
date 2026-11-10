import { describe, expect, it } from "vitest";
import { COMMANDS, COMMAND_HELP, helpLines, parseInput } from "./command-parser.js";
import type { InputContext } from "./command-parser.js";

const channel: InputContext = { ownNick: "me", active: { kind: "channel", target: "#lab" } };
const status: InputContext = { ownNick: "me", active: { kind: "status", target: "" } };

describe("/notice and /privmsg (audit 10.1)", () => {
  it("sends the whole text of /notice as one trailing parameter and echoes it as a notice", () => {
    expect(parseInput("/notice bob hello world", channel)).toEqual({
      kind: "send",
      messages: [{ command: "NOTICE", params: ["bob", "hello world"] }],
      echo: [{ target: "bob", text: "hello world", notice: true }],
    });
  });

  it("sends the whole text of /privmsg and opens a query for a nick target", () => {
    expect(parseInput("/privmsg bob hello there world", channel)).toEqual({
      kind: "send",
      messages: [{ command: "PRIVMSG", params: ["bob", "hello there world"] }],
      echo: [{ target: "bob", text: "hello there world" }],
      openQuery: "bob",
    });
    const toChannel = parseInput("/privmsg #lab hi all", status);
    expect(toChannel).toMatchObject({ kind: "send", messages: [{ command: "PRIVMSG", params: ["#lab", "hi all"] }] });
    expect(toChannel.kind === "send" && toChannel.openQuery).toBeFalsy();
  });

  it("reports usage without text and rejects CR, LF and NUL", () => {
    expect(parseInput("/notice bob", channel).kind).toBe("error");
    expect(parseInput("/privmsg", channel).kind).toBe("error");
    for (const bad of ["\r", "\n", "\0"]) {
      expect(parseInput(`/notice bob a${bad}b`, channel).kind).toBe("error");
      expect(parseInput(`/privmsg bob a${bad}b`, channel).kind).toBe("error");
    }
  });
});

describe("messages to oneself (audit 10.18)", () => {
  it.each(["/msg me hi there", "/notice ME hi there", "/privmsg Me hi there", "/query me hi there"])(
    "%s sends nothing and opens no query",
    (line) => {
      const r = parseInput(line, channel);
      expect(r.kind).toBe("local");
      if (r.kind !== "local" || r.action.type !== "active-lines") throw new Error("expected active-lines");
      expect(r.action.lines.join(" ")).toContain("hi there");
    },
  );

  it("/query with only the own nick explains instead of opening a window", () => {
    expect(parseInput("/query me", channel)).toMatchObject({ kind: "local", action: { type: "active-lines" } });
  });
});

describe("/help and /clear (audit 10.2)", () => {
  it("documents exactly the commands of the table", () => {
    expect(Object.keys(COMMAND_HELP).sort()).toEqual(Object.keys(COMMANDS).sort());
  });

  it("prints one usage line per command into the active window and sends nothing", () => {
    const r = parseInput("/help", channel);
    expect(r.kind).toBe("local");
    if (r.kind !== "local" || r.action.type !== "active-lines") throw new Error("expected active-lines");
    expect(r.action.lines).toEqual(helpLines());
    expect(r.action.lines.length).toBeGreaterThanOrEqual(Object.keys(COMMANDS).length);
    for (const name of Object.keys(COMMANDS)) {
      expect(r.action.lines.some((l) => l.includes(`/${name}`))).toBe(true);
    }
  });

  it("/clear is a local action", () => {
    expect(parseInput("/clear", channel)).toEqual({ kind: "local", action: { type: "clear" } });
  });
});

describe("/list, /ban and /unban (audit 10.8, 10.11)", () => {
  it("/list without arguments opens the dialog; with arguments it still sends LIST", () => {
    expect(parseInput("/list", status)).toEqual({ kind: "local", action: { type: "channel-list" } });
    expect(parseInput("/list #a*", status)).toMatchObject({ messages: [{ command: "LIST", params: ["#a*"] }] });
  });

  it("/ban sets +b on the active channel, or lists the bans", () => {
    expect(parseInput("/ban coder", channel)).toMatchObject({ messages: [{ command: "MODE", params: ["#lab", "+b", "coder"] }] });
    expect(parseInput("/ban #x coder", status)).toMatchObject({ messages: [{ command: "MODE", params: ["#x", "+b", "coder"] }] });
    expect(parseInput("/ban", channel)).toMatchObject({ messages: [{ command: "MODE", params: ["#lab", "b"] }] });
    expect(parseInput("/ban coder", status).kind).toBe("error");
  });

  it("/unban sets -b and needs a mask", () => {
    expect(parseInput("/unban coder", channel)).toMatchObject({ messages: [{ command: "MODE", params: ["#lab", "-b", "coder"] }] });
    expect(parseInput("/unban", channel).kind).toBe("error");
  });
});
