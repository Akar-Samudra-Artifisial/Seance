import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { validateServerUrl } from "./connect-src.js";

const scheme = fc.constantFrom("ws", "wss", "http", "https", "ftp", "WS", "WSS");
const host = fc.constantFrom("127.0.0.1", "irc.example.com", "Irc.Example.com", "evil.test", "localhost");
// Ports avoid the scheme defaults (80, 443), which URL parsing drops from the origin.
const port = fc.option(fc.integer({ min: 1024, max: 65535 }), { nil: undefined });
const suffix = fc.constantFrom("", "/", "/ws", "/a/b");
const padding = fc.constantFrom("", " ", "\t", "  ");

interface Parts {
  readonly scheme: string;
  readonly host: string;
  readonly port: number | undefined;
}

const parts: fc.Arbitrary<Parts> = fc.record({ scheme, host, port });

function origin(p: Parts): string {
  return `${p.scheme}://${p.host}${p.port === undefined ? "" : `:${p.port}`}`.toLowerCase();
}

const allowedList = fc.array(
  fc
    .record({
      scheme: fc.constantFrom("ws", "wss"),
      host,
      port,
    })
    .map(origin),
  { minLength: 1, maxLength: 4 },
);

describe("validateServerUrl properties", () => {
  it("P15 server url accepted only for allowed origins", () => {
    // **Validates: Requirements 3.1, 3.2, 4.4, 17.18**
    fc.assert(
      fc.property(parts, suffix, padding, padding, allowedList, (p, sfx, lead, trail, allowed) => {
        const raw = `${lead}${p.scheme}://${p.host}${p.port === undefined ? "" : `:${p.port}`}${sfx}${trail}`;
        const result = validateServerUrl(raw, allowed);
        const wsScheme = p.scheme.toLowerCase() === "ws" || p.scheme.toLowerCase() === "wss";
        const expectedOk = wsScheme && allowed.includes(origin(p));
        expect(result.ok).toBe(expectedOk);
        if (result.ok) {
          expect(result.origin).toBe(origin(p));
          expect(result.url).toBe(raw.trim());
        } else {
          for (const o of allowed) {
            expect(result.error).toContain(o);
          }
        }
      }),
      { numRuns: 300 },
    );
  });

  it("P15 server url rejects arbitrary strings with an error naming every origin", () => {
    // **Validates: Requirements 3.1, 3.2, 4.4, 17.18**
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), allowedList, (raw, allowed) => {
        const result = validateServerUrl(raw, allowed);
        if (!result.ok) {
          for (const o of allowed) {
            expect(result.error).toContain(o);
          }
        } else {
          expect(allowed).toContain(result.origin);
        }
      }),
      { numRuns: 300 },
    );
  });
});
