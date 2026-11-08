/** Why a sandbox step failed (agent-sandbox Requirement 3.4, design "Data Models"). */
export type SandboxErrorKind =
  | "podman-missing"
  | "podman-version"
  | "not-rootless"
  | "image-missing"
  | "auth-missing"
  | "probe-failed"
  | "invalid-input"
  | "start-failed"
  | "start-timeout"
  | "remove-failed";

/**
 * A sandbox step failed. The message says what failed and what to change; it never contains a
 * secret value (Requirement 3.4). `detail` is an already redacted tail (for example podman stderr).
 */
export class SandboxError extends Error {
  readonly kind: SandboxErrorKind;
  readonly detail: string | undefined;

  constructor(kind: SandboxErrorKind, message: string, detail?: string) {
    super(message);
    this.name = "SandboxError";
    this.kind = kind;
    this.detail = detail;
  }
}
