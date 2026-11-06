import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { normalizeHost } from "../src/host.js";

const octet = fc.integer({ min: 0, max: 255 });
const dottedQuad = fc.tuple(octet, octet, octet, octet).map((o) => o.join("."));
const hexGroup = fc.integer({ min: 0, max: 0xffff }).map((n) => n.toString(16));
const ipv6 = fc.array(hexGroup, { minLength: 1, maxLength: 8 }).map((g) => g.join(":"));
const ffffCase = fc
  .array(fc.boolean(), { minLength: 4, maxLength: 4 })
  .map((flags) => [..."ffff"].map((c, i) => (flags[i] ? c.toUpperCase() : c)).join(""));

const mappedDotted = fc.tuple(ffffCase, dottedQuad).map(([f, q]) => `::${f}:${q}`);
const mappedHex = fc.tuple(ffffCase, ipv6).map(([f, r]) => `::${f}:${r}`);
const leadingColon = fc.string({ maxLength: 20 }).map((s) => `:${s}`);

const peerAddress = fc.oneof(
  fc.constant(""),
  dottedQuad,
  ipv6,
  leadingColon,
  mappedDotted,
  mappedHex,
  fc.string({ maxLength: 40 }),
);

describe("normalizeHost properties", () => {
  // Feature: ircd-agent-commands, Property 4: normalizeHost is idempotent and never yields a leading ':'
  it("P4 host normalization shape: is idempotent, never starts with ':', and strips ::ffff: from dotted-quad input", () => {
    fc.assert(
      fc.property(peerAddress, (addr) => {
        const once = normalizeHost(addr);
        expect(normalizeHost(once)).toBe(once);
        expect(once?.startsWith(":") ?? false).toBe(false);
      }),
      { numRuns: 200 },
    );
    fc.assert(
      fc.property(ffffCase, dottedQuad, (f, q) => {
        const out = normalizeHost(`::${f}:${q}`);
        expect(out).toBe(q);
        expect(out?.toLowerCase().includes("::ffff:") ?? false).toBe(false);
      }),
      { numRuns: 200 },
    );
  });
});
