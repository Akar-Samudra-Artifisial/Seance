import { LineFramer } from "@seance/irc-protocol";
import { describe, expect, it } from "vitest";
import { decodeFrames } from "./framing.js";

describe("decodeFrames", () => {
  it("returns every line of a multi-line frame in order", () => {
    const out = decodeFrames(new LineFramer(), "PING :a\r\n:srv 001 me :Hi\r\nNOTICE x :y\n");
    expect(out).toEqual([
      { kind: "line", line: "PING :a" },
      { kind: "line", line: ":srv 001 me :Hi" },
      { kind: "line", line: "NOTICE x :y" },
    ]);
  });

  it("buffers a partial line until a later frame completes it", () => {
    const framer = new LineFramer();
    expect(decodeFrames(framer, "PRIVMSG #a :hel")).toEqual([]);
    expect(decodeFrames(framer, "lo\r")).toEqual([]);
    expect(decodeFrames(framer, "\nPING :x\r\nPAR")).toEqual([
      { kind: "line", line: "PRIVMSG #a :hello" },
      { kind: "line", line: "PING :x" },
    ]);
    expect(decodeFrames(framer, "T #a\r\n")).toEqual([{ kind: "line", line: "PART #a" }]);
  });

  it("reports an overlong line once and keeps decoding later lines", () => {
    const framer = new LineFramer();
    const out = decodeFrames(framer, `PRIVMSG #a :${"x".repeat(600)}\r\nPING :ok\r\n`);
    expect(out).toEqual([{ kind: "overlong" }, { kind: "line", line: "PING :ok" }]);
  });

  it("decodes a multi-byte character", () => {
    expect(decodeFrames(new LineFramer(), "PRIVMSG #a :👻é\r\n")).toEqual([
      { kind: "line", line: "PRIVMSG #a :👻é" },
    ]);
  });
});
