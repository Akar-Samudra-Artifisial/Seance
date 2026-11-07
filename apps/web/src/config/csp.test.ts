import { describe, expect, it } from "vitest";
import { buildCsp } from "./csp";

function directive(csp: string, name: string): string[] {
  const part = csp.split("; ").find((d) => d.startsWith(`${name} `));
  if (part === undefined) throw new Error(`missing directive ${name}`);
  return part.split(" ").slice(1);
}

describe("buildCsp", () => {
  const base = { nonce: "abc123==", connectOrigins: ["ws://irc.example:6668"] } as const;

  it("production script-src has nonce and strict-dynamic, no unsafe keywords", () => {
    const csp = buildCsp({ ...base, dev: false });
    const script = directive(csp, "script-src");
    expect(script).toContain("'nonce-abc123=='");
    expect(script).toContain("'strict-dynamic'");
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
  });

  it("production connect-src is 'self' plus the given origins only", () => {
    const csp = buildCsp({ ...base, dev: false });
    expect(directive(csp, "connect-src")).toEqual(["'self'", "ws://irc.example:6668"]);
  });

  it("sets object-src and frame-ancestors to none, no upgrade-insecure-requests", () => {
    const csp = buildCsp({ ...base, dev: false });
    expect(directive(csp, "object-src")).toEqual(["'none'"]);
    expect(directive(csp, "frame-ancestors")).toEqual(["'none'"]);
    expect(csp).not.toContain("upgrade-insecure-requests");
    expect(csp).not.toContain("\n");
  });

  it("development adds unsafe-eval and the default local Ircd origin", () => {
    const csp = buildCsp({ ...base, dev: true });
    expect(directive(csp, "script-src")).toContain("'unsafe-eval'");
    expect(directive(csp, "connect-src")).toContain("ws://127.0.0.1:6668");
  });

  it("does not duplicate the dev origin", () => {
    const csp = buildCsp({ nonce: "n", connectOrigins: ["ws://127.0.0.1:6668"], dev: true });
    expect(directive(csp, "connect-src").filter((v) => v === "ws://127.0.0.1:6668")).toHaveLength(1);
  });

  it("rejects nonces and origins that could inject directives", () => {
    expect(() => buildCsp({ ...base, nonce: "a; script-src *", dev: false })).toThrow(/nonce/);
    expect(() => buildCsp({ nonce: "n", connectOrigins: ["x; img-src *"], dev: false })).toThrow(/origin/);
  });
});
