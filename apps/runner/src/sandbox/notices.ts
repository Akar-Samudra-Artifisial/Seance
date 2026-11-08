/**
 * Sandbox failure notices (agent-sandbox Requirement 11): a fixed reason per `SandboxErrorKind`, and
 * for `container failed to start` the last podman stderr line after control stripping, redaction,
 * path scrubbing and a 200-byte cut.
 */
import { redact, redactValues } from "../acp/redact.js";
import type { SandboxError, SandboxErrorKind } from "./errors.js";

export const SANDBOX_REASONS: Readonly<Record<SandboxErrorKind, string>> = {
  "podman-missing": "podman not found",
  "podman-version": "podman too old (need 5 or newer)",
  "not-rootless": "podman is not rootless",
  "image-missing": "sandbox image not found",
  "auth-missing": "container failed to start",
  "probe-failed": "network isolation check failed",
  "invalid-input": "container failed to start",
  "start-failed": "container failed to start",
  "start-timeout": "container start timed out",
  "remove-failed": "container failed to start",
};

const DETAIL_MAX_BYTES = 200;

/** Truncates to at most `max` UTF-8 bytes without splitting a code point. */
function clampBytes(text: string, max: number): string {
  if (Buffer.byteLength(text, "utf8") <= max) return text;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch, "utf8");
    if (used + n > max) break;
    out += ch;
    used += n;
  }
  return out;
}

/**
 * Makes a podman stderr line safe for IRC and logs (Requirement 11.2, 11.4): controls removed,
 * secrets redacted, absolute paths replaced by `<path>`, at most 200 bytes.
 */
export function scrubDetail(line: string, secrets: readonly (string | undefined)[] = []): string {
  // eslint-disable-next-line no-control-regex
  const plain = line.replace(/[\u0000-\u001F\u007F]/g, " ");
  const safe = redact(redactValues(plain, secrets)).replace(/(^|[\s"'`=(:])\/[^\s"'`,)]*/g, "$1<path>");
  return clampBytes(safe.replace(/\s+/g, " ").trim(), DETAIL_MAX_BYTES);
}

/** `sandbox: <agent> not started in <channel>: <reason>` (Requirement 11.1). */
export function sandboxNotice(agent: string, channel: string, err: SandboxError): string {
  const reason = SANDBOX_REASONS[err.kind];
  const detail = err.kind === "start-failed" && err.detail !== undefined && err.detail !== "" ? `: ${err.detail}` : "";
  return `sandbox: ${agent} not started in ${channel}: ${reason}${detail}`;
}
