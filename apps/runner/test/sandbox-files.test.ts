// agent-sandbox task 8.5 (Requirements 1.8, 3.3, 7.3, 7.6, 7.7, 12.8): the shipped image, probe and
// network files agree with the runner and keep their safety properties.
import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { PROBE_EXIT } from "../src/sandbox/flags.js";

const exec = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), "utf8");
const DOCKERFILES = ["sandbox/Dockerfile", "apps/runner/test/fixtures/sandbox/Dockerfile"];
const SCRIPTS = ["sandbox/seance-entry", "sandbox/seance-probe", "sandbox/seance-egress-refresh"];

describe("image pinning (12.8, decision 5)", () => {
  it.each(DOCKERFILES)("%s pins every FROM by digest", (file) => {
    const froms = read(file)
      .split("\n")
      .filter((l) => /^\s*FROM\s/i.test(l));
    expect(froms.length).toBeGreaterThan(0);
    for (const line of froms) expect(line).toMatch(/@sha256:[0-9a-f]{64}(\s|$)/);
  });

  // Review finding 5: the kiro-cli binary the operator supplies is checked against a digest the
  // operator states, as root and before the image drops to the agent user.
  it("sandbox/Dockerfile verifies the kiro-cli sha256 from a required build arg, before USER", () => {
    const text = read("sandbox/Dockerfile");
    const lines = text.split("\n");
    const at = (re: RegExp): number => lines.findIndex((l) => re.test(l));
    expect(at(/^ARG KIRO_CLI_SHA256$/)).toBeGreaterThan(-1);
    const check = at(/sha256sum -c/);
    expect(check).toBeGreaterThan(at(/^COPY .*\bkiro-cli\b/));
    expect(check).toBeLessThan(at(/^USER 10001:10001$/));
    expect(text).toMatch(/test -n "\$\{?KIRO_CLI_SHA256\}?"/); // an unset arg fails the build
    expect(text).toMatch(/\/usr\/local\/bin\/kiro-cli/);
  });

  // Review item 1 (replaces the finding 5 test that kept $HOME exec-able until verified): noexec
  // is applied to both tmpfs mounts, and every program the container starts lives in the image.
  it("both tmpfs mounts are noexec, and kiro-cli, the entrypoint and the probe sit in /usr/local/bin of the image", () => {
    const flags = read("apps/runner/src/sandbox/flags.ts");
    // Spike S12: the home tmpfs carries U so the keep-id agent user owns it.
    expect(flags).toMatch(/TMPFS_HOME = "\/home\/agent:rw,nosuid,nodev,noexec,size=256m,U"/);
    expect(flags).toMatch(/TMPFS_TMP = "\/tmp:rw,nosuid,nodev,noexec,size=256m"/);
    for (const file of DOCKERFILES) {
      const text = read(file);
      expect(text).toContain('ENTRYPOINT ["/usr/local/bin/seance-entry"]');
      expect(text).toMatch(/\/usr\/local\/bin\/(?:kiro-cli|seance-entry)/);
      expect(text).not.toMatch(/\/home\/agent\/\S*(?:kiro-cli|seance)/);
    }
    expect(read("sandbox/Dockerfile")).toMatch(/COPY .*kiro-cli \/usr\/local\/bin\/kiro-cli/);
    expect(read("sandbox/Dockerfile")).toMatch(/COPY .*seance-entry seance-probe \/usr\/local\/bin\//);
    // seance-entry starts the command by name (PATH) or by the image path SEANCE_KIRO_BIN names.
    expect(read("sandbox/seance-entry")).toContain('exec "${SEANCE_KIRO_BIN:-kiro-cli}"');
  });

  it("README and docs/SANDBOX.md state that .gitmodules and nested .git are refused by design (review item 4)", () => {
    for (const file of ["README.md", "docs/SANDBOX.md"]) {
      const text = read(file);
      expect(text, file).toMatch(/\.gitmodules/);
      expect(text, file).toMatch(/nested `\.git`/);
      expect(text, file).toMatch(/by design|deliberate/);
    }
  });

  it("docs/SANDBOX.md and README require SEANCE_SANDBOX_BLOCKED_CIDRS for a public host and call the probe best effort (review item 2)", () => {
    for (const file of ["README.md", "docs/SANDBOX.md"]) {
      const text = read(file);
      expect(text, file).toMatch(/SEANCE_SANDBOX_BLOCKED_CIDRS/);
      expect(text, file).toMatch(/IRCD_PUBLIC=1/);
      expect(text, file).toMatch(/best effort/i);
    }
    const doc = read("docs/SANDBOX.md");
    expect(doc).toMatch(/looks exactly like one the rule drops/);
  });

  it("docs/SANDBOX.md states noexec as applied and lists DNS tunnelling as a residual risk", () => {
    const doc = read("docs/SANDBOX.md");
    expect(doc).toMatch(/--tmpfs=\/home\/agent:rw,nosuid,nodev,noexec/);
    expect(doc).not.toMatch(/mounted without `noexec`/);
    expect(doc).toMatch(/DNS tunnell?ing/i);
  });

  it("the image runs as uid 10001 with seance-entry as the entrypoint", () => {
    const text = read("sandbox/Dockerfile");
    expect(text).toMatch(/^USER 10001:10001$/m);
    expect(text).toContain('ENTRYPOINT ["/usr/local/bin/seance-entry"]');
    expect(text).not.toMatch(/KIRO_API_KEY/);
  });
});

describe("scripts", () => {
  it.each(SCRIPTS)("%s is executable POSIX sh", (file) => {
    expect(read(file).startsWith("#!/bin/sh\n")).toBe(true);
    expect(() => accessSync(resolve(ROOT, file), constants.X_OK)).not.toThrow();
  });

  it("seance-probe documents the launcher's exit codes", () => {
    const text = read("sandbox/seance-probe");
    for (const [name, code] of Object.entries(PROBE_EXIT)) {
      expect(text, name).toMatch(new RegExp(`^#\\s+${code}\\s`, "m"));
      if (code !== 0) expect(text, name).toContain(`exit ${code}`);
    }
  });

  it("seance-entry stages the auth dir and never touches KIRO_API_KEY", () => {
    const text = read("sandbox/seance-entry");
    expect(text).toContain("/run/seance/auth");
    expect(text).not.toContain("KIRO_API_KEY");
  });
});

describe("seance-probe behaviour on this host", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((r) => (server === undefined ? r() : server.close(() => r())));
    server = undefined;
  });

  it("exits 2 on a usage error and 13 when an extra target is reachable", async () => {
    const hasNc = await exec("sh", ["-c", "command -v nc"]).then(
      () => true,
      () => false,
    );
    const probe = resolve(ROOT, "sandbox/seance-probe");
    const usage = await exec(probe, ["x"]).catch((e: { code?: number }) => e);
    expect((usage as { code?: number }).code).toBe(2);
    // The reachability path needs netcat-openbsd semantics (`-w` bounds the connect), as in the
    // image; BSD nc on macOS ignores `-w` for connects, so the metadata check could hang there.
    if (!hasNc || process.platform !== "linux") return;
    server = createServer((s) => s.destroy());
    await new Promise<void>((r) => server?.listen(0, "127.0.0.1", () => r()));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    // The metadata check may take its 2 s timeout on a laptop; the extra target is local.
    const result = await exec(probe, ["1", `127.0.0.1:${port}`]).catch((e: { code?: number }) => e);
    expect([PROBE_EXIT.egress, PROBE_EXIT.metadata]).toContain((result as { code?: number }).code);
  }, 15_000);
});

describe("nftables template (7.3, D19)", () => {
  const text = read("sandbox/seance-sandbox.nft");
  const rules = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
  const at = (pattern: RegExp): number => rules.findIndex((l) => pattern.test(l));

  it("matches the runner's user and has every placeholder", () => {
    expect(text).toContain('meta skuid != "@RUNNER_USER@" accept');
    expect(text).toContain("@VPC_CIDR@");
    expect(text).toContain("@RESOLVER@");
  });

  it("orders DNS, the metadata and VPC drops, loopback, HTTPS to the allow-list, then a final drop", () => {
    const dns = at(/^ip daddr @RESOLVER@ udp dport 53 accept$/);
    const metadata = at(/^ip daddr 169\.254\.0\.0\/16 drop$/);
    const vpc = at(/^ip daddr @VPC_CIDR@ drop$/);
    const loopback = at(/^ip daddr 127\.0\.0\.0\/8 accept$/);
    const https = at(/^ip daddr @seance_allow4 tcp dport 443 accept$/);
    const last = at(/^drop$/);
    for (const i of [dns, metadata, vpc, loopback, https, last]) expect(i).toBeGreaterThanOrEqual(0);
    expect(dns).toBeLessThan(metadata);
    expect(metadata).toBeLessThan(vpc);
    expect(vpc).toBeLessThan(loopback);
    expect(loopback).toBeLessThan(https);
    expect(https).toBeLessThan(last);
    expect(rules.filter((l) => /dport 443/.test(l))).toHaveLength(1); // HTTPS only
  });

  it("the allow-list holds the Kiro endpoints and package registries, names only", () => {
    const names = read("sandbox/egress-allow.txt")
      .split("\n")
      .map((l) => l.replace(/#.*/, "").trim())
      .filter((l) => l !== "");
    expect(names).toEqual(expect.arrayContaining(["runtime.us-east-1.kiro.dev", "registry.npmjs.org", "pypi.org"]));
    for (const n of names) expect(n).toMatch(/^[A-Za-z0-9.-]+$/);
  });
});
