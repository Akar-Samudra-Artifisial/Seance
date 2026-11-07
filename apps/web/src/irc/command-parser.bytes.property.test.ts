import { serialize } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseInput } from "./command-parser.js";
import type { InputContext } from "./command-parser.js";

const LIMIT = 512;
const encoder = new TextEncoder();

/** Bytes of the serialized line including CRLF; Infinity when serialize refuses the message. */
function lineBytes(msg: IrcMessage): number {
  try {
    return encoder.encode(serialize(msg)).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

type Mode = "plain-channel" | "plain-query" | "msg-channel" | "msg-nick" | "me-channel" | "me-query";

interface Case {
  readonly input: (text: string) => string;
  readonly ctx: InputContext;
  readonly expected: (text: string) => IrcMessage;
}

const own = "me1";
const cases: Readonly<Record<Mode, Case>> = {
  "plain-channel": {
    input: (t) => t,
    ctx: { ownNick: own, active: { kind: "channel", target: "#chan" } },
    expected: (t) => ({ command: "PRIVMSG", params: ["#chan", t] }),
  },
  "plain-query": {
    input: (t) => t,
    ctx: { ownNick: own, active: { kind: "query", target: "bob" } },
    expected: (t) => ({ command: "PRIVMSG", params: ["bob", t] }),
  },
  "msg-channel": {
    input: (t) => `/msg #room ${t}`,
    ctx: { ownNick: own, active: { kind: "status", target: "" } },
    expected: (t) => ({ command: "PRIVMSG", params: ["#room", t] }),
  },
  "msg-nick": {
    input: (t) => `/msg alice ${t}`,
    ctx: { ownNick: own, active: { kind: "status", target: "" } },
    expected: (t) => ({ command: "PRIVMSG", params: ["alice", t] }),
  },
  "me-channel": {
    input: (t) => `/me ${t}`,
    ctx: { ownNick: own, active: { kind: "channel", target: "#chan" } },
    expected: (t) => ({ command: "PRIVMSG", params: ["#chan", `\x01ACTION ${t}\x01`] }),
  },
  "me-query": {
    input: (t) => `/me ${t}`,
    ctx: { ownNick: own, active: { kind: "query", target: "bob" } },
    expected: (t) => ({ command: "PRIVMSG", params: ["bob", `\x01ACTION ${t}\x01`] }),
  },
};

const modeArb = fc.constantFrom<Mode>(...(Object.keys(cases) as Mode[]));
const multiByteArb = fc.constantFrom("é", "€", "😀");
const byteLen = (s: string): number => encoder.encode(s).length;

// Text of ASCII letters and multi-byte characters, with the total size landing within a few bytes of the limit.
const textArb = fc
  .record({
    mode: modeArb,
    head: fc.array(multiByteArb, { maxLength: 60 }),
    delta: fc.integer({ min: -8, max: 8 }),
    tailMulti: fc.array(multiByteArb, { maxLength: 2 }),
  })
  .map(({ mode, head, delta, tailMulti }) => {
    const c = cases[mode];
    const headText = head.join("");
    const tailText = tailMulti.join("");
    const base = lineBytes(c.expected("x" + headText + tailText));
    // Bytes available for padding so that the line is exactly LIMIT + delta bytes.
    const pad = Math.max(0, LIMIT + delta - base + 1);
    return { mode, text: "x" + headText + "a".repeat(pad) + tailText };
  });

describe("Property 8: Byte limit is enforced in UTF-8 bytes", () => {
  it("P8 byte limit enforced in utf8 bytes", { timeout: 60_000 }, () => {
    fc.assert(
      fc.property(textArb, ({ mode, text }) => {
        const c = cases[mode];
        const result = parseInput(c.input(text), c.ctx);
        const bytes = lineBytes(c.expected(text));
        if (bytes <= LIMIT) {
          expect(result.kind).toBe("send");
          if (result.kind === "send") {
            expect(result.messages).toEqual([c.expected(text)]);
            for (const m of result.messages) expect(lineBytes(m)).toBeLessThanOrEqual(LIMIT);
          }
        } else {
          expect(result.kind).toBe("error");
          if (result.kind === "error") expect(result.text).toMatch(/512 bytes|byte/i);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("P8 boundary examples: 512 bytes sends, 513 bytes errors, with multi-byte text", { timeout: 10_000 }, () => {
    const c = cases["plain-channel"];
    const base = lineBytes(c.expected("€"));
    const fit = "€" + "a".repeat(LIMIT - base);
    expect(byteLen(fit) + base - 3).toBe(LIMIT);
    expect(parseInput(fit, c.ctx).kind).toBe("send");
    expect(parseInput(fit + "a", c.ctx).kind).toBe("error");
    // Character count is far below 512 but the byte count is above it.
    expect(parseInput("😀".repeat(130), c.ctx).kind).toBe("error");
  });
});
