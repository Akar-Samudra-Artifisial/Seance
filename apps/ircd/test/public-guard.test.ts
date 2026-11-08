// agent-sandbox Requirement 2.1 to 2.3: IRCD_PUBLIC parsing and the startup refusal, before any
// listener (main() calls checkPublicStartup first and exits 1 on a throw).
import { describe, expect, it } from "vitest";
import { checkPublicStartup, parsePublic, PublicConfigError } from "../src/public-guard.js";

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
      expect(() => checkPublicStartup({ IRCD_PUBLIC: "1", SEANCE_RUNNER: "1", SEANCE_SANDBOX: sandbox })).toThrow(
        /IRCD_PUBLIC.*SEANCE_SANDBOX/,
      );
    }
  });

  // Review item 2: fail closed when the VPC range is not named.
  it("refuses a public podman server without SEANCE_SANDBOX_BLOCKED_CIDRS, naming the variable", () => {
    for (const cidrs of [undefined, "", "  ", ",", " , "]) {
      const env = { IRCD_PUBLIC: "1", SEANCE_RUNNER: "1", SEANCE_SANDBOX: "podman", SEANCE_SANDBOX_BLOCKED_CIDRS: cidrs };
      expect(() => checkPublicStartup(env)).toThrow(/SEANCE_SANDBOX_BLOCKED_CIDRS/);
    }
  });

  it("accepts a public podman server with at least one blocked CIDR; a private one needs none", () => {
    expect(
      checkPublicStartup({ IRCD_PUBLIC: "1", SEANCE_RUNNER: "1", SEANCE_SANDBOX: "podman", SEANCE_SANDBOX_BLOCKED_CIDRS: "10.0.0.0/16" }),
    ).toEqual({ publicDeployment: true });
    expect(checkPublicStartup({ SEANCE_RUNNER: "1", SEANCE_SANDBOX: "podman" })).toEqual({ publicDeployment: false });
  });

  it("accepts a public server with the sandbox and CIDRs, or without the runner", () => {
    expect(
      checkPublicStartup({ IRCD_PUBLIC: "1", SEANCE_RUNNER: "1", SEANCE_SANDBOX: "podman", SEANCE_SANDBOX_BLOCKED_CIDRS: "10.0.0.0/16" }),
    ).toEqual({ publicDeployment: true });
    expect(checkPublicStartup({ IRCD_PUBLIC: "1" })).toEqual({ publicDeployment: true });
    expect(checkPublicStartup({ SEANCE_RUNNER: "1" })).toEqual({ publicDeployment: false });
  });
});
