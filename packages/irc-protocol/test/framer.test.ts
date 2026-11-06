import { describe, expect, it } from "vitest";
import { LineFramer } from "../src/index.js";
import type { FramerEvent } from "../src/index.js";

const lines = (events: readonly FramerEvent[]): readonly string[] =>
  events.flatMap((e) => (e.kind === "line" ? [e.line] : []));

describe("LineFramer", () => {
  it("splits CRLF lines and buffers a partial trailing line", () => {
    const f = new LineFramer();
    expect(lines(f.push("NICK a\r\nUSER b"))).toEqual(["NICK a"]);
    expect(lines(f.push(" 0 * :c\r\n"))).toEqual(["USER b 0 * :c"]);
  });

  it("tolerates bare LF and CR split from its LF", () => {
    const f = new LineFramer();
    expect(lines(f.push("A\nB\r"))).toEqual(["A"]);
    expect(lines(f.push("\nC\n"))).toEqual(["B", "C"]);
  });

  it("discards empty lines", () => {
    const f = new LineFramer();
    expect(f.push("\r\n\n\r\nPING x\r\n")).toEqual([{ kind: "line", line: "PING x" }]);
  });

  it("accepts a line of exactly 512 bytes including CRLF", () => {
    const body = "a".repeat(510);
    expect(lines(new LineFramer().push(`${body}\r\n`))).toEqual([body]);
  });

  it("flags a 513-byte line once and keeps framing afterwards", () => {
    const f = new LineFramer();
    const events = f.push(`${"a".repeat(511)}\r\nOK\r\n`);
    expect(events).toEqual([{ kind: "overlong" }, { kind: "line", line: "OK" }]);
  });

  it("emits a single overlong flag for a huge line spread over chunks", () => {
    const f = new LineFramer();
    const events = [
      ...f.push("b".repeat(2000)),
      ...f.push("b".repeat(2000)),
      ...f.push("\nPING y\n"),
    ];
    expect(events).toEqual([{ kind: "overlong" }, { kind: "line", line: "PING y" }]);
  });

  it("decodes multi-byte UTF-8 split across chunks", () => {
    const bytes = new TextEncoder().encode("PRIVMSG #c :héllo ☃\r\n");
    const f = new LineFramer();
    const out: FramerEvent[] = [];
    for (const b of bytes) {
      out.push(...f.push(new Uint8Array([b])));
    }
    expect(lines(out)).toEqual(["PRIVMSG #c :héllo ☃"]);
  });

  it("measures the limit in bytes, not characters", () => {
    // 171 snowmen = 513 bytes but only 171 characters.
    const events = new LineFramer().push(`${"☃".repeat(171)}\r\n`);
    expect(events).toEqual([{ kind: "overlong" }]);
  });
});
