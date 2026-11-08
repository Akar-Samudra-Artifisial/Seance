// agent-sandbox Requirement 11.1 to 11.4: notice texts from a fixed table, safe stderr tails.
import { describe, expect, it } from "vitest";
import { SandboxError } from "../src/sandbox/errors.js";
import { SANDBOX_REASONS, sandboxNotice, scrubDetail } from "../src/sandbox/notices.js";

describe("sandboxNotice", () => {
  it.each([
    ["podman-missing", "podman not found"],
    ["podman-version", "podman too old (need 5 or newer)"],
    ["not-rootless", "podman is not rootless"],
    ["image-missing", "sandbox image not found"],
    ["start-timeout", "container start timed out"],
    ["probe-failed", "network isolation check failed"],
  ] as const)("%s -> %s", (kind, reason) => {
    expect(sandboxNotice("coder", "#dev", new SandboxError(kind, "internal message /home/x"))).toBe(
      `sandbox: coder not started in #dev: ${reason}`,
    );
  });

  it("adds the scrubbed stderr tail only for container failed to start", () => {
    const err = new SandboxError("start-failed", "x", scrubDetail("Error: crun: open `/home/runner/.secret`: denied"));
    expect(sandboxNotice("coder", "#dev", err)).toBe("sandbox: coder not started in #dev: container failed to start: Error: crun: open `<path>`: denied");
  });

  it("uses only the fixed reasons", () => {
    expect(new Set(Object.values(SANDBOX_REASONS))).toEqual(
      new Set([
        "podman not found",
        "podman too old (need 5 or newer)",
        "podman is not rootless",
        "sandbox image not found",
        "container failed to start",
        "container start timed out",
        "network isolation check failed",
      ]),
    );
  });
});

describe("scrubDetail (11.2, 11.4)", () => {
  it("strips controls, redacts known secrets and secret-looking keys, hides paths, cuts at 200 bytes", () => {
    const line = `\u001b[31mError\u0007: token "KEY-123" at /var/lib/x and "api_key":"abc" ${"é".repeat(200)}`;
    const out = scrubDetail(line, ["KEY-123"]);
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[\u0000-\u001F]/);
    expect(out).not.toContain("KEY-123");
    expect(out).not.toContain("abc");
    expect(out).not.toContain("/var/lib");
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(200);
  });
});
