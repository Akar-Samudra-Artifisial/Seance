import type { SandboxMode } from "../config.js";

/** Thrown when a public deployment would run agents outside the sandbox (Requirement 2.2). */
export class PublicSandboxError extends Error {
  constructor() {
    super(
      "IRCD_PUBLIC=1 with SEANCE_RUNNER=1 requires SEANCE_SANDBOX=podman: a public server must not run agents on the host",
    );
    this.name = "PublicSandboxError";
  }
}

/**
 * Pure production guard (agent-sandbox Requirement 2.4). Throws only when the deployment is public,
 * the runner is enabled and the sandbox is not podman; without the runner no agent can run (2.3).
 */
export function assertSandboxForPublic(o: {
  readonly public: boolean;
  readonly runnerEnabled: boolean;
  readonly sandbox: SandboxMode;
}): void {
  if (o.public && o.runnerEnabled && o.sandbox !== "podman") throw new PublicSandboxError();
}
