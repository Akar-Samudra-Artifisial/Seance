import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeConnectConfig } from "./src/config/connect-src";
import { proxy } from "./proxy";

function directive(csp: string, name: string): string {
  const found = csp.split("; ").find((d) => d.startsWith(`${name} `));
  if (found === undefined) throw new Error(`directive ${name} missing in ${csp}`);
  return found;
}

describe("proxy CSP (development)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows inline styles without a nonce in style-src and still nonces scripts", () => {
    vi.stubEnv("NODE_ENV", "development");
    const csp = proxy(new NextRequest("http://localhost:3000/")).headers.get("Content-Security-Policy") ?? "";
    expect(directive(csp, "style-src")).toBe("style-src 'self' 'unsafe-inline'");
    expect(directive(csp, "script-src")).toMatch(/'nonce-[^']+'/);
  });
});

describe("proxy CSP (production)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("emits a fresh nonce CSP without unsafe script sources", () => {
    vi.stubEnv("NODE_ENV", "production");
    const { allowedOrigins } = computeConnectConfig(process.env);

    const nonces: string[] = [];
    for (let i = 0; i < 2; i++) {
      const response = proxy(new NextRequest("http://localhost:3000/"));
      const csp = response.headers.get("Content-Security-Policy");
      expect(csp).not.toBeNull();
      const script = directive(csp ?? "", "script-src");
      const match = /'nonce-([^']+)'/.exec(script);
      expect(match).not.toBeNull();
      nonces.push(match?.[1] ?? "");
      expect(script).not.toContain("'unsafe-inline'");
      expect(script).not.toContain("'unsafe-eval'");
      expect(directive(csp ?? "", "connect-src")).toBe(
        `connect-src 'self' ${allowedOrigins.join(" ")}`,
      );
    }
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  it("production style-src has the nonce and no unsafe-inline", () => {
    vi.stubEnv("NODE_ENV", "production");
    const csp = proxy(new NextRequest("http://localhost:3000/")).headers.get("Content-Security-Policy") ?? "";
    const style = directive(csp, "style-src");
    expect(style).toMatch(/'nonce-[^']+'/);
    expect(style).not.toContain("'unsafe-inline'");
  });

  it("adds nosniff, no-referrer and a restrictive Permissions-Policy", () => {
    const response = proxy(new NextRequest("http://localhost:3000/"));
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
    const policy = response.headers.get("Permissions-Policy") ?? "";
    for (const feature of ["camera", "microphone", "geolocation"]) expect(policy).toContain(`${feature}=()`);
  });
});
