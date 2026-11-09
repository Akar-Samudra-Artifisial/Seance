// agent-sandbox task 8.5 (Requirements 1.8, 3.3, 7.3, 7.6, 7.7, 12.8): the shipped image, probe and
// network files agree with the runner and keep their safety properties.
import { execFile } from "node:child_process";
import { accessSync, constants, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

// deploy-aws: the Kiro login refresh (task 7). The script itself needs root, runuser and kiro-cli,
// so these tests pin the shipped files and run only its SQLite helper.
describe("Kiro login refresh (deploy-aws)", () => {
  const SCRIPT = "deploy/seance-kiro-refresh.sh";
  const installUnits = (): string => {
    const text = read("deploy/bootstrap.sh");
    const start = text.indexOf("install_units() {");
    return text.slice(start, text.indexOf("\n}\n", start));
  };

  it("the timer fires 2 minutes after boot, then 20 minutes after each run ended, with 30 s accuracy", () => {
    const timer = read("deploy/systemd/seance-kiro-refresh.timer");
    expect(timer).toMatch(/^OnBootSec=2min$/m);
    // Inactive, not Active: scheduling must continue after a failed run.
    expect(timer).toMatch(/^OnUnitInactiveSec=20min$/m);
    expect(timer).not.toMatch(/^OnUnitActiveSec=/m);
    expect(timer).toMatch(/^AccuracySec=30s$/m);
    expect(timer).toMatch(/^WantedBy=timers\.target$/m);
  });

  it("the service is a oneshot that runs the installed script as seance, hardened", () => {
    const service = read("deploy/systemd/seance-kiro-refresh.service");
    expect(service).toMatch(/^Type=oneshot$/m);
    expect(service).toMatch(/^ExecStart=\/usr\/local\/sbin\/seance-kiro-refresh$/m);
    expect(service).toMatch(/^User=seance$/m);
    expect(service).toMatch(/^Group=seance$/m);
    for (const line of [
      "NoNewPrivileges=yes",
      "PrivateTmp=yes",
      "ProtectSystem=strict",
      "ReadWritePaths=/home/seance/.local/share/kiro-cli",
      "ProtectKernelTunables=yes",
      "ProtectKernelModules=yes",
      "ProtectControlGroups=yes",
      "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
      "LockPersonality=yes",
      "RestrictRealtime=yes",
      "UMask=0077",
    ]) {
      expect(service, line).toMatch(new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    }
    // The script reads ~/.local/bin and writes the login: no ProtectHome, read-only or not.
    expect(service).not.toMatch(/^ProtectHome=/m);
  });

  it("bootstrap.sh installs the script (root-owned, 0755) and both units, and enables the timer only with the agents", () => {
    const bootstrap = read("deploy/bootstrap.sh");
    const units = installUnits();
    expect(units).toContain("seance-kiro-refresh.service");
    expect(units).toContain("seance-kiro-refresh.timer");
    expect(units).toMatch(/install -m 0755 -o root -g root "\$REPO_DIR\/deploy\/seance-kiro-refresh\.sh" \/usr\/local\/sbin\/seance-kiro-refresh/);
    expect(units).not.toMatch(/enable[^\n]*seance-kiro-refresh/);
    const enables = bootstrap.split("\n").filter((l) => /systemctl enable[^\n]*seance-kiro-refresh\.timer/.test(l));
    expect(enables).toHaveLength(2); // agents already running, and agents being started
    const gate = bootstrap.indexOf("main() {");
    for (const line of enables) expect(bootstrap.indexOf(line)).toBeGreaterThan(gate);
    expect(bootstrap.slice(bootstrap.indexOf("elif ready_for_agents; then"))).toMatch(/enable --now [^\n]*seance-kiro-refresh\.timer/);
  });

  it("update.sh reinstalls the script and both units, and enables the timer when agents were running", () => {
    const update = read("deploy/update.sh");
    expect(update).toContain("seance-kiro-refresh.service seance-kiro-refresh.timer");
    expect(update).toMatch(/install -m 0755 -o root -g root "\$REPO_DIR\/deploy\/seance-kiro-refresh\.sh" \/usr\/local\/sbin\/seance-kiro-refresh/);
    const guarded = update.slice(update.indexOf('if [ "$AGENTS_WERE_ACTIVE" -eq 1 ]; then'));
    expect(guarded.slice(0, guarded.indexOf("\n  fi\n"))).toContain("systemctl enable --now seance-kiro-refresh.timer");
  });

  it("the script is executable POSIX sh that runs as seance, on a copy, and installs it atomically", () => {
    const text = read(SCRIPT);
    expect(text.startsWith("#!/bin/sh\n")).toBe(true);
    expect(() => accessSync(resolve(ROOT, SCRIPT), constants.X_OK)).not.toThrow();
    // The variable names of bootstrap.sh.
    for (const name of ["SEANCE_USER", "SEANCE_HOME", "AUTH_DIR"]) expect(text).toMatch(new RegExp(`^${name}=`, "m"));
    // Runs as seance, never as root: no user switch and no ownership change anywhere in the file.
    expect(text).toContain('[ "$(id -un)" = "$SEANCE_USER" ]');
    expect(text).not.toContain("runuser");
    expect(text).not.toContain("chown");
    expect(text).not.toMatch(/\bsudo\b/);
    expect(text).toMatch(/^umask 077$/m);
    // Concurrency and freshness, in order: lock, WAL check, backup API, refresh, re-read, install.
    const at = (needle: string): number => {
      const i = text.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    expect(text).toContain('flock -n 9');
    expect(text).toContain("another refresh is running");
    const order = [
      at("flock -n 9"),
      at("if live_wal_busy; then"),
      at('py backup "$live_db" "$copy_db"'),
      at("timeout 60 kiro-cli whoami"),
      at('now=$(py live-expiry "$live_db"'),
      at('py checkpoint "$copy_db"'),
      at('sync "$staged"'),
      at('mv -f -- "$staged" "$live_db"'),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // Leftovers of a killed run are removed right after the lock (they hold a token).
    expect(at('rm -f -- "$AUTH_DIR"/.data.sqlite3.*')).toBeGreaterThan(at("flock -n 9"));
    expect(at('rm -f -- "$AUTH_DIR"/.data.sqlite3.*')).toBeLessThan(at("if live_wal_busy; then"));
    expect(text).toContain("|| sync"); // plain sync when the file argument is not supported
    // The live database is only read, so it is opened read-only; the copy stays read-write.
    expect(text).toContain("?mode=ro");
    expect(text).toContain("uri=True");
    expect(text).toContain("login changed during refresh");
    expect(text).toContain(".backup(dst)");
    expect(text).not.toMatch(/\bcp -a\b/); // a live database is never copied with cp
    expect(text).toContain("FORCED_EXPIRY=2000-01-01T00:00:00Z");
    expect(text).toContain("wal_checkpoint(TRUNCATE)");
    expect(text).toContain("refresh FAILED, login kept (expires $old)");
    expect(text).toContain('env -i "HOME=$work"');
    expect(text).toMatch(/\?"?, \(KEY,\)/); // parameterised queries
    expect(text).not.toContain("KIRO_API_KEY");
  });

  it("bootstrap.sh fixes the ownership of the auth dir without following symlinks", () => {
    const line = read("deploy/bootstrap.sh")
      .split("\n")
      .find((l) => l.includes('"$AUTH_DIR"') && /\bchown\b/.test(l));
    expect(line).toBeDefined();
    expect(line).toMatch(/chown -hR /);
  });

  it("CI shellcheck covers deploy/*.sh, so the script is checked", () => {
    expect(read(".github/workflows/ci.yml")).toContain("shellcheck --severity=style deploy/*.sh");
  });

  it("DEPLOY.md and SANDBOX.md describe the refresh", () => {
    const deploy = read("docs/DEPLOY.md");
    expect(deploy).toContain("journalctl -u seance-kiro-refresh");
    expect(deploy).toMatch(/disable --now seance-kiro-refresh\.timer/);
    const sandbox = read("docs/SANDBOX.md");
    expect(sandbox).toContain("kirodotdev/Kiro#4847");
    expect(sandbox).toContain("kirodotdev/Kiro#9783");
  });

  it("the SQLite helper moves expires_at back and forward and reports a missing row", async () => {
    const hasPython = await exec("python3", ["--version"]).then(
      () => true,
      () => false,
    );
    if (!hasPython) return;
    const helper = /<<'PY'\n([\s\S]*?)\nPY\n/.exec(read(SCRIPT))?.[1];
    expect(helper).toBeDefined();
    const dir = mkdtempSync(join(tmpdir(), "seance-kiro-refresh-"));
    try {
      const py = (args: readonly string[], input?: string): Promise<{ stdout: string; code: number }> =>
        new Promise((done) => {
          const child = execFile("python3", ["-c", input ?? "", ...args], (error, stdout) => {
            done({ stdout: stdout.trim(), code: error === null ? 0 : typeof error.code === "number" ? error.code : 1 });
          });
          child.stdin?.end();
        });
      // `python3 -c <code> <args>` makes `args[0]` the sys.argv[1] the script's helper expects.
      const run = (...args: string[]) => py(args, helper);
      const seed = `
import json, sqlite3, sys
for name, rows in (("login.db", [("kirocli:social:token", json.dumps({"access_token": "t-1", "expires_at": "2026-11-09T12:00:00Z"}))]), ("empty.db", [])):
    c = sqlite3.connect(sys.argv[1] + "/" + name)
    c.execute("create table auth_kv (key text primary key, value text)")
    for k, v in rows:
        c.execute("insert into auth_kv values (?, ?)", (k, v))
    c.commit()
    c.close()
`;
      expect((await py([dir], seed)).code).toBe(0);
      const db = join(dir, "login.db");
      expect(await run("expiry", db)).toEqual({ stdout: "2026-11-09T12:00:00Z", code: 0 });
      expect((await run("expire", db, "2000-01-01T00:00:00Z")).code).toBe(0);
      expect((await run("expiry", db)).stdout).toBe("2000-01-01T00:00:00Z");
      expect((await run("moved", "2000-01-01T00:00:00Z", "2026-11-09T13:00:00Z")).code).toBe(0);
      expect((await run("moved", "2000-01-01T00:00:00Z", "1999-01-01T00:00:00Z")).code).toBe(1);
      expect((await run("checkpoint", db)).code).toBe(0);
      expect((await run("expiry", join(dir, "empty.db"))).code).toBe(3);
      // The read-only open reads the same row, and cannot write to the database.
      expect(await run("live-expiry", db)).toEqual({ stdout: "2000-01-01T00:00:00Z", code: 0 });
      expect((await run("live-expiry", join(dir, "missing.db"))).code).toBe(4);
      // The backup API copies the database; changing the copy leaves the original alone.
      const copy = join(dir, "copy.db");
      expect((await run("backup", db, copy)).code).toBe(0);
      expect((await run("expire", copy, "1999-01-01T00:00:00Z")).code).toBe(0);
      expect((await run("expiry", copy)).stdout).toBe("1999-01-01T00:00:00Z");
      expect((await run("expiry", db)).stdout).toBe("2000-01-01T00:00:00Z");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

// deploy-aws task 8: the repeatable smoke test of a deployed host.
describe("tools/smoke-wss.mjs (deploy-aws)", () => {
  const SMOKE = "tools/smoke-wss.mjs";

  it("exists and reads the secret from SMOKE_SECRET only", () => {
    const text = read(SMOKE);
    expect(text.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(text).toContain('process.env["SMOKE_SECRET"]');
    // Exit 2 with a usage message when the secret or an argument is missing.
    expect(text).toMatch(/SMOKE_SECRET is not set/);
    expect(text).toMatch(/process\.exit\(2\)/);
    expect(text).not.toMatch(/process\.argv[^\n]*secret/i);
  });

  it("waits for the agent's JOIN and the worktree notice before it sends the prompt", () => {
    const text = read(SMOKE);
    const gate = text.indexOf("if (seen.promptScheduled || !seen.worktreeReady || !seen.agentJoined) return;");
    expect(gate).toBeGreaterThan(-1);
    // The prompt is sent only from maybeStartPrompt, after the gate, and the gate is fed by both events.
    expect(text.indexOf("PRIVMSG ${channel} :${agent} ${PROMPT}")).toBeGreaterThan(gate);
    expect(text.match(/PRIVMSG \$\{channel\} :\$\{agent\}/g)).toHaveLength(1);
    expect(text).toMatch(/seen\.worktreeReady = true;\s+step\("worktree ready"\);\s+maybeStartPrompt\(\);/);
    expect(text).toMatch(/seen\.agentJoined = true;[\s\S]*?maybeStartPrompt\(\);/);
    expect(text).toContain("MODE ${channel} +v ${agent}");
    expect(text).toContain("const PROMPT_DELAY_MS = 1500;");
  });

  it("kicks the agent on a failure after the invite, and fails on the documented conditions", () => {
    const text = read(SMOKE);
    expect(text).toMatch(/if \(invited\) kick\(\);/);
    expect(text).toContain("could not start");
    expect(text).toContain("credits used");
    expect(text).toMatch(/\^ERROR/);
    expect(text).toContain("SMOKE_TIMEOUT_S");
    expect(text).toContain("const DEFAULT_TIMEOUT_S = 120;");
    expect(text).toContain("smoke done");
  });

  it("never prints the PASS line or the secret", () => {
    const lines = read(SMOKE).split("\n");
    for (const line of lines) {
      if (/console\.(log|error|warn|info|debug)/.test(line) || /\bstep\(/.test(line)) {
        expect(line, line).not.toContain("PASS ");
        expect(line, line).not.toMatch(/\bsecret\b/i);
      }
    }
    // The PASS line goes to the socket through send(), nowhere else.
    const passUses = lines.filter((l) => l.includes("PASS ") && !l.trimStart().startsWith("//"));
    expect(passUses.map((l) => l.trim())).toEqual(["send(`PASS ${nick}:${secret}`);"]);
  });

  it("accepts the agent's line as the reply only after the prompt was delivered", () => {
    const text = read(SMOKE);
    // promptDelivered is set after the PRIVMSG inside the delay, never before; a failed or kicked run sends nothing.
    const timeoutAt = text.indexOf("setTimeout(() => {", text.indexOf("const maybeStartPrompt"));
    const sendAt = text.indexOf("send(`PRIVMSG ${channel} :${agent} ${PROMPT}`);", timeoutAt);
    const deliveredAt = text.indexOf("seen.promptDelivered = true;", timeoutAt);
    expect(timeoutAt).toBeGreaterThan(-1);
    expect(sendAt).toBeGreaterThan(timeoutAt);
    expect(deliveredAt).toBeGreaterThan(sendAt);
    expect(text.slice(timeoutAt, sendAt)).toContain("if (finished || kicked) return;");
    expect(text.match(/seen\.promptDelivered = true;/g)).toHaveLength(1);
    expect(text).toMatch(/command === "PRIVMSG" && fromAgent && [^\n]*seen\.promptDelivered && !kicked/);
    expect(text).not.toMatch(/command === "PRIVMSG"[^\n]*seen\.promptScheduled/);
  });

  it("handles SIGINT and SIGTERM through the failure path, which kicks and waits for the flush", () => {
    const text = read(SMOKE);
    expect(text).toContain('process.on("SIGINT", () => fail("interrupted"));');
    expect(text).toContain('process.on("SIGTERM", () => fail("interrupted"));');
    // fail() kicks whenever the invite was sent (not only after the agent joined), then end() drains the socket.
    expect(text).toMatch(/if \(invited\) kick\(\);\s+end\(1\);/);
    expect(text).toContain("const FLUSH_WAIT_MS = 500;");
    expect(text).toContain("socket.buffered()");
    // A socket error goes through fail() (so the agent is kicked while the socket may still be open).
    expect(text).toMatch(/socket\.onError\(\(reason\) => \{\s+fail\(/);
  });

  it("strips control characters, cuts to 200 characters and redacts the secret before printing server text", () => {
    const text = read(SMOKE);
    expect(text).toContain("const MAX_PRINTED = 200;");
    expect(text).toContain(String.raw`.replace(/[\x00-\x1f\x7f]/g, "")`);
    expect(text).toContain(String.raw`.replace(/\x03(\d{1,2}(,\d{1,2})?)?/g, "")`);
    expect(text).toContain('.split(secret)');
    expect(text).toContain('.join("<redacted>")');
    expect(text).toContain(".slice(0, MAX_PRINTED)");
    // Every printing path goes through clean(): step() and the FAIL line.
    expect(text).toMatch(/console\.log\(`\$\{stamp\(\)\} \$\{clean\(text\)\}`\)/);
    expect(text).toMatch(/console\.error\(`\$\{stamp\(\)\} FAIL: \$\{clean\(reason\)\}`\)/);
  });

  it("refuses a SMOKE_SECRET with CR, LF, NUL or a space (exit 2) without echoing it", async () => {
    const text = read(SMOKE);
    expect(text).toContain(String.raw`if (/[\r\n\0 ]/.test(secret)) usage(`);
    const run = (secret: string): Promise<{ code: number; stdout: string; stderr: string }> =>
      new Promise((done) => {
        execFile(
          process.execPath,
          [resolve(ROOT, SMOKE), "example.test", "judge1"],
          { env: { PATH: process.env["PATH"] ?? "", SMOKE_SECRET: secret } },
          (error, stdout, stderr) => {
            done({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, stdout, stderr });
          },
        );
      });
    for (const bad of ["has space-1234", "line\nbreak-1234", "carriage\rreturn-1234"]) {
      const result = await run(bad);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("must not contain CR, LF, NUL or a space");
      expect(result.stderr + result.stdout).not.toContain("space-1234");
      expect(result.stderr + result.stdout).not.toContain("break-1234");
    }
  });

  it("fails fast on JOIN and INVITE errors", () => {
    const text = read(SMOKE);
    expect(text).toMatch(/JOIN_ERRORS = new Set\(\["403", "405", "471", "473", "474", "475", "477"\]\)/);
    expect(text).toMatch(/INVITE_ERRORS = new Set\(\["401", "443", "482"\]\)/);
    expect(text).toContain("cannot join ${channel}");
    expect(text).toContain("invite of ${agent} refused");
  });

  it("uses a placeholder host in its header, never a real one", () => {
    const header = read(SMOKE).split("\n").slice(0, 12).join("\n");
    expect(header).toContain("seance.example.com");
    expect(header).not.toMatch(/sslip\.io/);
  });

  it("is syntactically valid Node", async () => {
    const result = await exec(process.execPath, ["--check", resolve(ROOT, SMOKE)]).then(
      () => 0,
      (e: { code?: number }) => e.code ?? 1,
    );
    expect(result).toBe(0);
  });

  it("exits 2 with a usage message when SMOKE_SECRET or an argument is missing", async () => {
    const run = (args: string[], env: Record<string, string>): Promise<{ code: number; stderr: string }> =>
      new Promise((done) => {
        execFile(process.execPath, [resolve(ROOT, SMOKE), ...args], { env: { PATH: process.env["PATH"] ?? "", ...env } }, (error, _out, stderr) => {
          done({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, stderr });
        });
      });
    const noSecret = await run(["example.test", "judge1"], {});
    expect(noSecret.code).toBe(2);
    expect(noSecret.stderr).toContain("SMOKE_SECRET is not set");
    const noNick = await run(["example.test"], { SMOKE_SECRET: "dummy-value-123456" });
    expect(noNick.code).toBe(2);
    expect(noNick.stderr).toContain("usage:");
    expect(noNick.stderr).not.toContain("dummy-value-123456");
  });
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
    // Without it kiro-cli 3.1.0 hangs in session/new (the invite fails with "session/new timed out").
    expect(names).toContain("desktop-release.q.us-east-1.amazonaws.com");
    // Social-login token refresh; without it every agent hangs once the one-hour access token expires.
    expect(names).toContain("prod.us-east-1.auth.desktop.kiro.dev");
    expect(names).toContain("cognito-identity.us-east-1.amazonaws.com"); // Kiro firewall page, social sign-in
    for (const n of names) expect(n).toMatch(/^[A-Za-z0-9.-]+$/);
  });
});
