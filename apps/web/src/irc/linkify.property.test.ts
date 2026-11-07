import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { linkify } from "./linkify.js";

const TIMEOUT_MS = 30_000;
const NUM_RUNS = 200;

// Fragments that make URLs, near-URLs, punctuation and multi-byte text common.
const fragmentArb = fc.oneof(
  fc.string({ maxLength: 12 }),
  fc.string({ unit: "grapheme", maxLength: 6 }),
  fc.constantFrom(
    "http://",
    "https://",
    "HTTP://",
    "example.com",
    "/path?q=1&r=2#frag",
    " ",
    "\n",
    "\t",
    ".",
    ",",
    "(",
    ")",
    "<",
    ">",
    "\"",
    "é",
    "👻",
    "javascript:",
    "data:",
    "ftp://",
    "mailto:",
  ),
  fc.webUrl(),
);
const textArb = fc.array(fragmentArb, { maxLength: 8 }).map((parts) => parts.join(""));

const BAD_SCHEMES = ["javascript:", "data:", "ftp://", "ftps://", "file://", "mailto:", "vbscript:", "ws://", "wss://"];
// Payload alphabet without `h`, so it can never spell `http`.
const PAYLOAD_CHARS = "abcdefgijklmnopqrstuvwxyz0123456789/:.-_()=,;%& ";
const payloadArb = fc
  .array(fc.constantFrom(...PAYLOAD_CHARS.split("")), { maxLength: 30 })
  .map((cs) => cs.join(""));

describe("linkify properties", () => {
  it(
    "P14 linkify keeps text and links only http https",
    () => {
      // Validates: Requirements 8.8, 8.9
      // Concatenated segment text equals the input; links are http(s) only.
      fc.assert(
        fc.property(textArb, (input) => {
          const segments = linkify(input);
          expect(segments.map((s) => s.text).join("")).toBe(input);
          for (const seg of segments) {
            if (seg.kind === "link") {
              expect(/^https?:\/\//i.test(seg.href)).toBe(true);
              expect(seg.href).toBe(seg.text);
            }
          }
        }),
        { numRuns: NUM_RUNS },
      );

      // Other schemes never become links, alone or surrounded by text.
      fc.assert(
        fc.property(
          fc.constantFrom(...BAD_SCHEMES),
          payloadArb,
          payloadArb,
          payloadArb,
          (scheme, before, payload, after) => {
            const input = `${before} ${scheme}${payload} ${after}`;
            const segments = linkify(input);
            expect(segments.map((s) => s.text).join("")).toBe(input);
            expect(segments.every((s) => s.kind === "text")).toBe(true);
            for (const seg of segments) {
              if (seg.kind === "link") expect(seg.href.toLowerCase().startsWith(scheme)).toBe(false);
            }
          },
        ),
        { numRuns: NUM_RUNS },
      );
    },
    TIMEOUT_MS,
  );
});
