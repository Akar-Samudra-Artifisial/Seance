// agent-sandbox Requirement 2: the production guard, every combination, and its repeat in start().
import { describe, expect, it } from "vitest";
import { loadRunnerConfig } from "../src/config.js";
import { createRunner } from "../src/runner.js";
import { assertSandboxForPublic, PublicSandboxError } from "../src/sandbox/guard.js";
import type { IrcHost } from "../src/ports.js";

const silent = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

describe("assertSandboxForPublic (2.4)", () => {
  const cases = [false, true].flatMap((pub) =>
    [false, true].flatMap((runnerEnabled) => (["none", "podman"] as const).map((sandbox) => ({ pub, runnerEnabled, sandbox }))),
  );
  it.each(cases)("public=$pub runner=$runnerEnabled sandbox=$sandbox", ({ pub, runnerEnabled, sandbox }) => {
    const refused = pub && runnerEnabled && sandbox !== "podman";
    const call = (): void => {
      assertSandboxForPublic({ public: pub, runnerEnabled, sandbox });
    };
    if (refused) {
      expect(call).toThrow(PublicSandboxError);
      expect(call).toThrow(/IRCD_PUBLIC.*SEANCE_SANDBOX/);
    } else {
      expect(call).not.toThrow();
    }
  });
});

describe("createRunner repeats the check in start() (2.5)", () => {
  it("rejects with publicDeployment and no sandbox, before touching the filesystem", async () => {
    // The host is never used: the guard runs first. Paths do not exist on purpose.
    const host = {} as unknown as IrcHost;
    const runner = createRunner({
      host,
      config: loadRunnerConfig({ SEANCE_TARGET_REPO: "/nonexistent-repo", SEANCE_WORKSPACES: "/nonexistent-ws" }, "/cwd"),
      logger: silent,
      bindHost: "127.0.0.1",
      publicDeployment: true,
    });
    await expect(runner.start()).rejects.toBeInstanceOf(PublicSandboxError);
  });
});
