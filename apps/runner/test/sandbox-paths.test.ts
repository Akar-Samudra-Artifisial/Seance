// agent-sandbox Requirement 5.3, 5.4: containment of the mounted paths.
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SandboxError } from "../src/sandbox/errors.js";
import { assertMountPaths, isWithin, resolveMountPaths } from "../src/sandbox/paths.js";

const OK = {
  sessionCwd: "/w/dev",
  worktreeRoot: "/w",
  agentsDir: "/agents",
  authDir: "/auth",
  targetRepo: "/repo",
};

describe("isWithin", () => {
  it("compares whole segments", () => {
    expect(isWithin("/w/dev", "/w")).toBe(true);
    expect(isWithin("/w", "/w")).toBe(true);
    expect(isWithin("/wx", "/w")).toBe(false);
  });
});

describe("assertMountPaths", () => {
  it("accepts a channel directory under the root", () => {
    expect(() => assertMountPaths(OK)).not.toThrow();
  });

  it.each([
    ["the root itself", { sessionCwd: "/w" }],
    ["outside the root", { sessionCwd: "/elsewhere" }],
    ["the filesystem root", { sessionCwd: "/", worktreeRoot: "/" }],
    ["containing the agents dir", { agentsDir: "/w/dev/agents" }],
    ["inside the agents dir", { worktreeRoot: "/agents", sessionCwd: "/agents/dev" }],
    ["containing the auth dir", { authDir: "/w/dev/.auth" }],
    ["auth inside agents", { authDir: "/agents/auth" }],
    ["containing the repo", { targetRepo: "/w/dev/repo" }],
  ])("refuses %s", (_what, patch) => {
    expect(() => assertMountPaths({ ...OK, ...patch })).toThrow(SandboxError);
  });

  it("allows the workspaces root inside the target repository (the repo's own workspaces/ dir)", () => {
    expect(() => assertMountPaths({ ...OK, worktreeRoot: "/repo/workspaces", sessionCwd: "/repo/workspaces/dev" })).not.toThrow();
  });
});

describe("resolveMountPaths", () => {
  it("realpaths the session directory, so a symlink out of the root is refused", async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), "seance-sbx-paths-")));
    try {
      await mkdir(join(base, "root"));
      await mkdir(join(base, "outside"));
      await symlink(join(base, "outside"), join(base, "root", "dev"));
      const err = await resolveMountPaths({
        sessionCwd: join(base, "root", "dev"),
        worktreeRoot: join(base, "root"),
        agentsDir: join(base, "agents"),
        authDir: join(base, "auth"),
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SandboxError);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
