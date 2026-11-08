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
 * Thrown when a public podman deployment names no range the host rule blocks (review item 2): the
 * start-up probe would then check only the metadata endpoint and the loopback, not the VPC.
 */
export class PublicEgressError extends Error {
  constructor() {
    super(
      "IRCD_PUBLIC=1 with SEANCE_SANDBOX=podman requires SEANCE_SANDBOX_BLOCKED_CIDRS (for example the VPC CIDR 10.0.0.0/16): " +
        "without it the start-up probe cannot check that the host rule blocks private networks",
    );
    this.name = "PublicEgressError";
  }
}

/**
 * Pure production guard (agent-sandbox Requirement 2.4). Throws only when the deployment is public
 * and the runner is enabled (without the runner no agent can run, 2.3): `PublicSandboxError` when
 * the sandbox is not podman, `PublicEgressError` when it is podman but `blockedCidrs` (how many
 * CIDRs are configured; missing counts as none) is zero.
 */
export function assertSandboxForPublic(o: {
  readonly public: boolean;
  readonly runnerEnabled: boolean;
  readonly sandbox: SandboxMode;
  readonly blockedCidrs?: number;
}): void {
  if (!o.public || !o.runnerEnabled) return;
  if (o.sandbox !== "podman") throw new PublicSandboxError();
  if ((o.blockedCidrs ?? 0) < 1) throw new PublicEgressError();
}
