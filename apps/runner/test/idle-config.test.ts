// agent-runner Requirement 9, criterion 18: SEANCE_IDLE_TIMEOUT_S, in both sandbox modes.
import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_IDLE_TIMEOUT_S, loadRunnerConfig } from "../src/config.js";
import type { EnvSource } from "../src/config.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const NONE: EnvSource = { SEANCE_TARGET_REPO: "/repo", SEANCE_WORKSPACES: "/ws" };
const PODMAN: EnvSource = {
  ...NONE,
  SEANCE_SANDBOX: "podman",
  SEANCE_SANDBOX_IMAGE: `localhost/seance-agent@${DIGEST}`,
  SEANCE_SANDBOX_AUTH_DIR: "/auth",
};

describe.each([
  ["none", NONE],
  ["podman", PODMAN],
])("SEANCE_IDLE_TIMEOUT_S with SEANCE_SANDBOX=%s", (_mode, base) => {
  const load = (value: string | undefined) =>
    loadRunnerConfig({ ...base, SEANCE_IDLE_TIMEOUT_S: value }, "/cwd");

  it.each([undefined, ""])("is absent for %j, so the runner default of 900 applies", (value) => {
    expect(load(value).idleTimeoutS).toBeUndefined();
    expect(DEFAULT_IDLE_TIMEOUT_S).toBe(900);
  });

  it.each([
    ["60", 60],
    ["900", 900],
    ["86400", 86_400],
  ])("accepts %s", (value, expected) => {
    expect(load(value).idleTimeoutS).toBe(expected);
  });

  it.each(["59", "86401", "0", "-60", "1.5", "abc", "60s", "1e3"])("rejects %j naming the variable", (value) => {
    expect(() => load(value)).toThrow(ConfigError);
    expect(() => load(value)).toThrow(/SEANCE_IDLE_TIMEOUT_S/);
  });
});
