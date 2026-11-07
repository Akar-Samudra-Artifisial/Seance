import { serialize } from "@seance/irc-protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { budgetFor, formatLines } from "../src/output/line-format.js";
import { SentenceBuffer } from "../src/output/sentence-buffer.js";
import { ManualClock } from "./fixtures/manual-clock.js";

/**
 * P5: every emitted line is at most 512 bytes with no CR, LF or NUL and no character is lost.
 * **Validates: Requirements 7.13, 7.5, 7.6, 7.7, 7.2**
 */
const TAG =
  "Feature: agent-runner, Property 5: every emitted line is at most 512 bytes with no CR, LF or NUL and no character is lost";
const RUNS = { numRuns: 300 } as const;

const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const HOST_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789-.";

const word = (chars: string, min: number, max: number): fc.Arbitrary<string> =>
  fc.array(fc.constantFrom(...chars), { minLength: min, maxLength: max }).map((a) => a.join(""));

const prefixArb = fc
  .tuple(word(LETTERS, 1, 30), word(LETTERS, 1, 10), word(HOST_CHARS, 1, 63))
  .map(([nick, user, host]) => `${nick}!${user}@${host}`);

/** `#` plus up to 50 characters of multi-byte text, no space, comma, BEL or control characters. */
const channelArb = fc
  .array(fc.constantFrom("日", "本", "é", "😀", "ß", "漢", "a", "👻", "ü"), { minLength: 1, maxLength: 50 })
  .map((a) => `#${a.join("")}`);

const chunkArb = fc.oneof(
  { weight: 4, arbitrary: fc.string({ unit: "binary", maxLength: 40 }) },
  { weight: 3, arbitrary: fc.constantFrom("Hello there. ", "Done! ", "Why? ", "line one", "日本語です。 ", "x") },
  { weight: 3, arbitrary: fc.integer({ min: 1, max: 400 }).map((n) => "😀".repeat(n)) },
  { weight: 2, arbitrary: fc.integer({ min: 1, max: 400 }).map((n) => "é日".repeat(n)) },
  { weight: 2, arbitrary: fc.constantFrom("\r\n", "\n", "\r", "\0", "  ", "\t", ". ", "\ud800", "\udc00") },
);
const chunksArb = fc.array(chunkArb, { maxLength: 12 });

function collectSentences(chunks: readonly string[]): string[] {
  const out: string[] = [];
  const buf = new SentenceBuffer({ clock: new ManualClock(), emit: (s) => out.push(s) });
  for (const c of chunks) buf.append(c);
  buf.flush();
  return out;
}

const stripWhitespace = (s: string): string => s.replace(/\s/g, "");

function render(chunks: readonly string[], prefix: string, channel: string, color: number) {
  const budget = budgetFor(prefix, channel);
  const wire: string[] = [];
  const texts: string[] = [];
  for (const sentence of collectSentences(chunks)) {
    for (const line of formatLines(sentence, color, budget)) {
      wire.push(serialize({ prefix, command: "PRIVMSG", params: [channel, line] }));
      texts.push(line);
    }
  }
  return { wire, texts };
}

describe("P5 output line bound", () => {
  it(TAG, () => {
    fc.assert(
      fc.property(chunksArb, prefixArb, channelArb, fc.integer({ min: 0, max: 15 }), (chunks, prefix, channel, color) => {
        const { wire, texts } = render(chunks, prefix, channel, color);
        const open = `\x03${String(color).padStart(2, "0")}`;
        let joined = "";
        for (const [i, line] of wire.entries()) {
          // (a) byte bound, (b) only the terminating CRLF
          expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(512);
          expect(line.endsWith("\r\n")).toBe(true);
          expect(/[\r\n\0]/.test(line.slice(0, -2))).toBe(false);
          // (c) text between color code and reset is visible
          const raw = texts[i] ?? "";
          expect(raw.startsWith(open)).toBe(true);
          expect(raw.endsWith("\x0F")).toBe(true);
          const body = raw.slice(open.length, -1);
          expect(body.trim()).not.toBe("");
          joined += body;
        }
        // (d) nothing lost or duplicated, order kept (whitespace between sentences is trimmed)
        // eslint-disable-next-line no-control-regex
        const expected = stripWhitespace(chunks.join("").replace(/[\u0000-\u001F\u007F]/g, ""));
        expect(stripWhitespace(joined)).toBe(expected);
      }),
      RUNS,
    );
  });

  it(`${TAG} (chunk boundaries do not change the text)`, () => {
    fc.assert(
      fc.property(chunksArb, (chunks) => {
        const split = stripWhitespace(collectSentences(chunks).join("").replace(/[\0]/g, ""));
        const whole = stripWhitespace(collectSentences([chunks.join("")]).join("").replace(/[\0]/g, ""));
        expect(split).toBe(whole);
      }),
      RUNS,
    );
  });

  it("longest case: 30-byte nick, 63-byte host, 4-byte emoji run still fits 512 bytes", () => {
    const prefix = `${"n".repeat(30)}!${"u".repeat(10)}@${"h".repeat(63)}`;
    const channel = `#${"😀".repeat(50)}`;
    const { wire } = render(["😀".repeat(2000)], prefix, channel, 15);
    expect(wire.length).toBeGreaterThan(1);
    for (const line of wire) expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(512);
  });
});
