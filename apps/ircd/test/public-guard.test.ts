// agent-sandbox Requirement 2.1 to 2.3: IRCD_PUBLIC parsing and the startup refusal, before any
// listener (main() calls checkPublicStartup first and exits 1 on a throw).
// public-hardening Requirement 8: a public server also needs every other protection.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { hashSecret } from "../src/accounts.js";
import { checkPublicStartup, parsePublic, PublicConfigError, PublicHardeningError } from "../src/public-guard.js";

const dir = mkdtempSync(join(tmpdir(), "seance-guard-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function accountsFile(name: string, text: string, mode = 0o600): string {
  const path = join(dir, name);
  writeFileSync(path, text);
  chmodSync(path, mode);
  return path;
}

const goodAccounts = accountsFile("accounts", `alice:${hashSecret("correct horse battery", { N: 1024, r: 8, p: 1 })}\n`);

/** Every public-hardening protection in place; tests remove one at a time. */
const HARDENED = {
  IRCD_SERVER_PASSWORD: "a-very-long-server-password",
  IRCD_ACCOUNTS_FILE: goodAccounts,
  IRCD_WS_ALLOWED_ORIGINS: "https://seance.example",
  IRCD_HOST: "127.0.0.1",
  IRCD_TRUSTED_PROXIES: "127.0.0.1,::1",
  SEANCE_INVITERS: "alice",
  SEANCE_DAILY_CREDIT_CAP: "20",
} as const;

describe("IRCD_PUBLIC (2.1)", () => {
  it.each([
    [undefined, false],
    ["", false],
    ["0", false],
    ["1", true],
  ])("%j -> %s", (raw, expected) => {
    expect(parsePublic(raw)).toBe(expected);
  });

  it.each(["true", "yes", "2", " 1"])("%j stops startup naming the variable", (raw) => {
    expect(() => parsePublic(raw)).toThrow(PublicConfigError);
    expect(() => parsePublic(raw)).toThrow(/IRCD_PUBLIC/);
  });
});

describe("checkPublicStartup (2.2, 2.3)", () => {
  it("refuses a public server with the runner and no podman sandbox, naming both variables", () => {
    for (const sandbox of [undefined, "", "none", "docker"]) {
      expect(() =>
        checkPublicStartup({ ...HARDENED, IRCD_PUBLIC: "1", SEANCE_RUNNER: "1", SEANCE_SANDBOX: sandbox }),
      ).toThrow(/IRCD_PUBLIC.*SEANCE_SANDBOX/);
    }
  });

  // Review item 2: fail closed when the VPC range is not named.
  it("refuses a public podman server without SEANCE_SANDBOX_BLOCKED_CIDRS, naming the variable", () => {
    for (const cidrs of [undefined, "", "  ", ",", " , "]) {
      const env = { ...HARDENED, IRCD_PUBLIC: "1", SEANCE_RUNNER: "1", SEANCE_SANDBOX: "podman", SEANCE_SANDBOX_BLOCKED_CIDRS: cidrs };
      expect(() => checkPublicStartup(env)).toThrow(/SEANCE_SANDBOX_BLOCKED_CIDRS/);
    }
  });

  // Changed by public-hardening Requirement 8: sandbox and CIDRs alone no longer suffice for a
  // public server, so the accepted environments now carry the HARDENED variables too.
  it("accepts a public podman server with at least one blocked CIDR; a private one needs none", () => {
    expect(
      checkPublicStartup({
        ...HARDENED,
        IRCD_PUBLIC: "1",
        SEANCE_RUNNER: "1",
        SEANCE_SANDBOX: "podman",
        SEANCE_SANDBOX_BLOCKED_CIDRS: "10.0.0.0/16",
      }),
    ).toEqual({ publicDeployment: true });
    expect(checkPublicStartup({ SEANCE_RUNNER: "1", SEANCE_SANDBOX: "podman" })).toEqual({ publicDeployment: false });
  });

  it("accepts a public server with the sandbox and CIDRs, or without the runner", () => {
    expect(
      checkPublicStartup({
        ...HARDENED,
        IRCD_PUBLIC: "1",
        SEANCE_RUNNER: "1",
        SEANCE_SANDBOX: "podman",
        SEANCE_SANDBOX_BLOCKED_CIDRS: "10.0.0.0/16",
      }),
    ).toEqual({ publicDeployment: true });
    expect(checkPublicStartup({ ...HARDENED, IRCD_PUBLIC: "1" })).toEqual({ publicDeployment: true });
    expect(checkPublicStartup({ SEANCE_RUNNER: "1" })).toEqual({ publicDeployment: false });
  });
});

describe("public hardening (public-hardening Requirement 8)", () => {
  const RUNNER = { IRCD_PUBLIC: "1", SEANCE_RUNNER: "1", SEANCE_SANDBOX: "podman", SEANCE_SANDBOX_BLOCKED_CIDRS: "10.0.0.0/16" };

  it("names every missing variable in one error", () => {
    let error: unknown;
    try {
      checkPublicStartup(RUNNER);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(PublicHardeningError);
    const message = (error as Error).message;
    for (const name of [
      "IRCD_SERVER_PASSWORD",
      "IRCD_ACCOUNTS_FILE",
      "IRCD_WS_ALLOWED_ORIGINS",
      "IRCD_HOST",
      "IRCD_TRUSTED_PROXIES",
      "SEANCE_INVITERS",
      "SEANCE_DAILY_CREDIT_CAP",
    ]) {
      expect(message).toContain(name);
    }
  });

  it.each([
    ["IRCD_SERVER_PASSWORD", { IRCD_SERVER_PASSWORD: "only-19-characters!" }],
    ["IRCD_ACCOUNTS_FILE", { IRCD_ACCOUNTS_FILE: "" }],
    ["IRCD_ACCOUNTS_FILE", { IRCD_ACCOUNTS_FILE: join(dir, "missing") }],
    ["IRCD_ACCOUNTS_FILE", { IRCD_ACCOUNTS_FILE: accountsFile("empty", "# no accounts yet\n") }],
    ["IRCD_ACCOUNTS_FILE", { IRCD_ACCOUNTS_FILE: accountsFile("open", `bob:${hashSecret("x".repeat(12), { N: 1024, r: 8, p: 1 })}\n`, 0o644) }],
    ["IRCD_WS_ALLOWED_ORIGINS", { IRCD_WS_ALLOWED_ORIGINS: "" }],
    ["IRCD_WS_ALLOWED_ORIGINS", { IRCD_WS_ALLOWED_ORIGINS: "*" }],
    ["IRCD_WS_ALLOWED_ORIGINS", { IRCD_WS_ALLOWED_ORIGINS: "https://a.example,http://b.example" }],
    ["IRCD_HOST", { IRCD_HOST: undefined }],
    ["IRCD_HOST", { IRCD_HOST: "0.0.0.0" }],
    // public-hardening Requirement 11.1: without the proxy list every user behind Caddy shares one address.
    ["IRCD_TRUSTED_PROXIES", { IRCD_TRUSTED_PROXIES: undefined }],
    ["IRCD_TRUSTED_PROXIES", { IRCD_TRUSTED_PROXIES: " , " }],
    ["IRCD_TRUSTED_PROXIES", { IRCD_TRUSTED_PROXIES: "127.0.0.1,10.0.0.5" }],
    ["IRCD_TRUSTED_PROXIES", { IRCD_TRUSTED_PROXIES: "localhost" }],
    ["SEANCE_INVITERS", { SEANCE_INVITERS: " , " }],
    ["SEANCE_DAILY_CREDIT_CAP", { SEANCE_DAILY_CREDIT_CAP: undefined }],
  ])("refuses when %s is unsafe (%j)", (name, override) => {
    const env = { ...HARDENED, ...RUNNER, ...override };
    expect(() => checkPublicStartup(env)).toThrow(PublicHardeningError);
    expect(() => checkPublicStartup(env)).toThrow(new RegExp(name));
  });

  it("does not require runner variables when the runner is off", () => {
    const ircdOnly = { ...HARDENED, SEANCE_INVITERS: undefined, SEANCE_DAILY_CREDIT_CAP: undefined };
    expect(checkPublicStartup({ ...ircdOnly, IRCD_PUBLIC: "1" })).toEqual({ publicDeployment: true });
  });

  it("accepts loopback proxy addresses in every spelling", () => {
    for (const proxies of ["127.0.0.1", "::1", "127.0.0.2, ::ffff:127.0.0.1", "0:0:0:0:0:0:0:1"]) {
      expect(checkPublicStartup({ ...HARDENED, IRCD_PUBLIC: "1", IRCD_TRUSTED_PROXIES: proxies })).toEqual({ publicDeployment: true });
    }
  });

  it("checks nothing extra for a private server", () => {
    expect(checkPublicStartup({ IRCD_HOST: "0.0.0.0", IRCD_WS_ALLOWED_ORIGINS: "*" })).toEqual({ publicDeployment: false });
  });
});
