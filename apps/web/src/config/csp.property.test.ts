import { NextRequest } from "next/server";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxy } from "../../proxy";
import { buildCsp } from "./csp";

const DEV_ORIGIN = "ws://127.0.0.1:6668";
const TIMEOUT = 30_000;

const nonceArb = fc.stringMatching(/^[A-Za-z0-9+/]{1,64}={0,2}$/);

const hostArb = fc.stringMatching(/^[a-z][a-z0-9]{0,10}(\.[a-z][a-z0-9]{0,10}){0,2}$/);
const originArb = fc
  .tuple(fc.constantFrom("ws", "wss", "http", "https"), hostArb, fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }))
  .map(([scheme, host, port]) => `${scheme}://${host}${port === undefined ? "" : `:${port}`}`)
  .filter((o) => o !== DEV_ORIGIN);
const originsArb = fc.array(originArb, { maxLength: 5 });

function parse(csp: string): Map<string, readonly string[]> {
  const map = new Map<string, readonly string[]>();
  for (const part of csp.split("; ")) {
    const [name, ...values] = part.split(" ");
    if (name === undefined || name === "") throw new Error(`empty directive in ${csp}`);
    map.set(name, values);
  }
  return map;
}

describe("csp properties", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it(
    "P16 csp header holds nonce and origins",
    () => {
      // **Validates: Requirements 15.3, 15.8, 15.9, 15.10, 17.17**
      fc.assert(
        fc.property(nonceArb, originsArb, fc.boolean(), (nonce, origins, dev) => {
          const csp = buildCsp({ nonce, connectOrigins: origins, dev });
          expect(csp).not.toMatch(/[\r\n]/);
          expect(csp).not.toContain("upgrade-insecure-requests");

          const d = parse(csp);
          const script = d.get("script-src") ?? [];
          const style = d.get("style-src") ?? [];
          expect(script).toContain(`'nonce-${nonce}'`);
          expect(style).toContain(`'nonce-${nonce}'`);
          if (!dev) {
            expect(script).not.toContain("'unsafe-inline'");
            expect(script).not.toContain("'unsafe-eval'");
          }
          expect(d.get("connect-src")).toEqual(
            dev ? ["'self'", ...origins, DEV_ORIGIN] : ["'self'", ...origins],
          );
          expect(d.get("object-src")).toEqual(["'none'"]);
          expect(d.get("frame-ancestors")).toEqual(["'none'"]);
        }),
        { numRuns: 100 },
      );
    },
    TIMEOUT,
  );

  it(
    "P16 proxy issues a different nonce per request",
    () => {
      vi.stubEnv("NODE_ENV", "production");
      const nonceOf = (): string => {
        const csp = proxy(new NextRequest("http://localhost:3000/")).headers.get(
          "Content-Security-Policy",
        );
        const match = /'nonce-([^']+)'/.exec(csp ?? "");
        if (match?.[1] === undefined) throw new Error(`no nonce in ${String(csp)}`);
        return match[1];
      };
      expect(nonceOf()).not.toBe(nonceOf());
    },
    TIMEOUT,
  );
});
