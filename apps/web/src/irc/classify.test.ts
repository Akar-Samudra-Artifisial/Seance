import { describe, expect, it } from "vitest";
import { KNOWN_AGENTS, classifyLine, isKnownAgent, markersFor } from "./classify.js";

describe("isKnownAgent", () => {
  it("lists the three agents", () => {
    expect([...KNOWN_AGENTS]).toEqual(["coder", "reviewer", "researcher"]);
  });
  it("compares case-insensitively", () => {
    expect(isKnownAgent("Coder")).toBe(true);
    expect(isKnownAgent("REVIEWER")).toBe(true);
    expect(isKnownAgent("alice")).toBe(false);
  });
});

describe("classifyLine", () => {
  it("classifies tool notices", () => {
    expect(classifyLine({ command: "NOTICE", from: "coder", text: "using tool: read_file" }).kind).toBe("tool");
  });
  it("classifies denied notices", () => {
    expect(classifyLine({ command: "NOTICE", from: "coder", text: "ops: shell denied" }).kind).toBe("tool-denied");
  });
  it("ignores tool-looking notices from non-agents", () => {
    expect(classifyLine({ command: "NOTICE", from: "alice", text: "using tool: x" }).kind).toBe("notice");
  });
  it("classifies exorcism PART", () => {
    expect(classifyLine({ command: "PART", nick: "coder", reason: "*** coder has been exorcised" }).kind).toBe(
      "exorcised",
    );
    expect(classifyLine({ command: "PART", nick: "coder", reason: "bye" }).kind).toBe("part");
  });
  it("classifies CTCP ACTION", () => {
    expect(classifyLine({ command: "PRIVMSG", from: "a", text: "\x01ACTION waves\x01" }).kind).toBe("action");
    expect(classifyLine({ command: "PRIVMSG", from: "a", text: "hi" }).kind).toBe("message");
  });

  describe("KICK (R17.19)", () => {
    it("exorcism with a reason", () => {
      const c = classifyLine({ command: "KICK", kicker: "op", target: "coder", reason: "stop" });
      expect(c).toEqual({ kind: "exorcised-kick", exorcism: { agent: "coder", kicker: "op", reason: "stop" } });
    });
    it("exorcism without a reason", () => {
      const c = classifyLine({ command: "KICK", kicker: "op", target: "coder", reason: "" });
      expect(c.exorcism?.reason).toBe("");
    });
    it("keeps a reason made only of control codes raw", () => {
      const c = classifyLine({ command: "KICK", kicker: "op", target: "coder", reason: "\x02\x03\x0f" });
      expect(c.kind).toBe("exorcised-kick");
      expect(c.exorcism?.reason).toBe("\x02\x03\x0f");
    });
    it("keeps the agent nick as sent for the Coder variant", () => {
      const c = classifyLine({ command: "KICK", kicker: "op", target: "Coder", reason: "" });
      expect(c.kind).toBe("exorcised-kick");
      expect(c.exorcism?.agent).toBe("Coder");
    });
    it("keeps a non-agent kick as kick", () => {
      const c = classifyLine({ command: "KICK", kicker: "op", target: "alice", reason: "x" });
      expect(c).toEqual({ kind: "kick" });
    });
    it("passes control codes in kicker and reason through untouched", () => {
      const c = classifyLine({ command: "KICK", kicker: "o\x02p", target: "coder", reason: "\x0304bad\x0f" });
      expect(c.exorcism).toEqual({ agent: "coder", kicker: "o\x02p", reason: "\x0304bad\x0f" });
    });
  });
});

describe("markersFor", () => {
  it("maps kinds to text markers", () => {
    // web-client-pixel-match follow-up: tool rows read `-tool- <text>` like Frame_01, and that
    // prefix is the text cue, so the `[tool]` marker was dropped on purpose.
    expect(markersFor("tool", false)).toEqual([]);
    expect(markersFor("tool-denied", false)).toEqual(["[denied]"]);
    expect(markersFor("exorcised", false)).toEqual([]);
    expect(markersFor("exorcised-kick", false)).toEqual([]);
    expect(markersFor("kick", false)).toEqual([]);
    expect(markersFor("message", true)).toEqual(["[mention]"]);
    expect(markersFor("message", false)).toEqual([]);
  });
});
