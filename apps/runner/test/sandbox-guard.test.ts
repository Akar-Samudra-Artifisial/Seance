// agent-sandbox Requirement 2: the production guard, every combination, and its repeat in start().
import { describe, expect, it } from "vitest";
import { loadRunnerConfig } from "../src/config.js";
import { createRunner } from "../src/runner.js";
import { assertSandboxForPublic, PublicEgressError, PublicSandboxError } from "../src/sandbox/guard.js";
import type { IrcHost } from "../src/ports.js";

const silent = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

describe("assertSandboxForPublic (2.4)", () => {
  const cases = [false, true].flatMap((pub) =>
    [false, true].flatMap((runnerEnabled) => (["none", "podman"] as const).map((sandbox) => ({ pub, runnerEnabled, sandbox }))),
  );
  it.each(cases)("public=$pub runner=$runnerEnabled sandbox=$sandbox", ({ pub, runnerEnabled, sandbox }) => {
    const refused = pub && runnerEnabled && sandbox !== "podman";
    const call = (): void => {
      // One blocked CIDR is configured, so only the sandbox rule can refuse here.
      assertSandboxForPublic({ public: pub, runnerEnabled, sandbox, blockedCidrs: 1 });
    };
    if (refused) {
      expect(call).toThrow(PublicSandboxError);
      expect(call).toThrow(/IRCD_PUBLIC.*SEANCE_SANDBOX/);
    } else {
      expect(call).not.toThrow();
    }
  });
});

// Review item 2: a public podman deployment without SEANCE_SANDBOX_BLOCKED_CIDRS has no VPC check
// at all, so it fails closed.
describe("blocked CIDRs are required for a public podman deployment", () => {
  it.each([
    [{ public: true, runnerEnabled: true, sandbox: "podman" as const, blockedCidrs: 0 }, true],
    [{ public: true, runnerEnabled: true, sandbox: "podman" as const }, true], // unspecified counts as none
    [{ public: true, runnerEnabled: true, sandbox: "podman" as const, blockedCidrs: 1 }, false],
    [{ public: true, runnerEnabled: true, sandbox: "podman" as const, blockedCidrs: 3 }, false],
    [{ public: false, runnerEnabled: true, sandbox: "podman" as const, blockedCidrs: 0 }, false], // not public: allowed
    [{ public: true, runnerEnabled: false, sandbox: "podman" as const, blockedCidrs: 0 }, false], // no runner, no agents
  ])("%j -> refused: %s", (input, refused) => {
    const call = (): void => {
      assertSandboxForPublic(input);
    };
    if (refused) {
      expect(call).toThrow(PublicEgressError);
      expect(call).toThrow(/SEANCE_SANDBOX_BLOCKED_CIDRS/);
      expect(call).toThrow(/IRCD_PUBLIC/);
    } else {
      expect(call).not.toThrow();
    }
  });

  it("without the sandbox the sandbox error comes first, whatever the CIDRs", () => {
    expect(() => assertSandboxForPublic({ public: true, runnerEnabled: true, sandbox: "none", blockedCidrs: 0 })).toThrow(PublicSandboxError);
  });
});

describe("createRunner repeats the check in start() (2.5)", () => {
  const options = (env: Record<string, string>) => ({
    // The host is never used: the guard runs first. Paths do not exist on purpose.
    host: {} as unknown as IrcHost,
    config: loadRunnerConfig({ SEANCE_TARGET_REPO: "/nonexistent-repo", SEANCE_WORKSPACES: "/nonexistent-ws", ...env }, "/cwd"),
    logger: silent,
    bindHost: "127.0.0.1",
    publicDeployment: true,
  });
  const PODMAN = {
    SEANCE_SANDBOX: "podman",
    SEANCE_SANDBOX_IMAGE: `localhost/seance@sha256:${"a".repeat(64)}`,
    SEANCE_SANDBOX_AUTH_DIR: "/nonexistent-auth",
  };

  it("rejects with publicDeployment and no sandbox, before touching the filesystem", async () => {
    await expect(createRunner(options({})).start()).rejects.toBeInstanceOf(PublicSandboxError);
  });

  it("rejects a public podman runner whose config has no blocked CIDRs, naming the variable", async () => {
    const err = await createRunner(options(PODMAN)).start().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PublicEgressError);
    expect((err as Error).message).toContain("SEANCE_SANDBOX_BLOCKED_CIDRS");
  });

  it("passes the guard with blocked CIDRs (and then fails later on the missing paths, not on the guard)", async () => {
    const err = await createRunner(options({ ...PODMAN, SEANCE_SANDBOX_BLOCKED_CIDRS: "10.0.0.0/16" })).start().catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(PublicEgressError);
    expect(err).not.toBeInstanceOf(PublicSandboxError);
  });
});
