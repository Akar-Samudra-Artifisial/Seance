// agent-sandbox design Properties 1 to 4: the podman argv for arbitrary inputs.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SandboxError } from "../src/sandbox/errors.js";
import * as F from "../src/sandbox/flags.js";
import { sandboxNotice } from "../src/sandbox/notices.js";
import { buildPodmanRunArgs, FIXED_FLAGS, type PodmanRunInput } from "../src/sandbox/podman-args.js";

const DIGEST = `sha256:${"c".repeat(64)}`;
const RUNS = { numRuns: 200 };

/** Path segments with the awkward characters a path may hold: spaces, `=`, `:`, a leading `-`. */
const segment = fc
  .array(fc.constantFrom("a", "b", "z", "0", "9", "-", "_", ".", " ", "=", ":", "é"), { minLength: 1, maxLength: 8 })
  .map((cs) => cs.join(""))
  .filter((s) => s !== "." && s !== ".." && s.trim() !== "");

const kiroAgent = fc
  .tuple(fc.constantFrom("a", "Z", "0"), fc.array(fc.constantFrom("a", "b", "9", ".", "_", "-"), { maxLength: 20 }))
  .map(([h, t]) => `${h}${t.join("")}`);

const forwardEnv = fc.subarray(["LANG", "TERM", "LC_ALL", "LC_CTYPE", "FAKE_AGENT_SCRIPT"]);

const validInput: fc.Arbitrary<PodmanRunInput> = fc
  .record({
    root: segment,
    channel: segment,
    agents: segment,
    auth: segment,
    privateSession: fc.boolean(),
    kiroAgent,
    forwardEnv,
    nick: fc.stringMatching(/^[a-z0-9-]{1,12}$/),
  })
  .map((r) => {
    const worktreeRoot = `/srv/${r.root}/ws`;
    return {
      config: { image: `localhost/seance@${DIGEST}`, authDir: `/srv/${r.auth}/auth`, memory: "2g", cpus: "1.5", pids: 128, timeoutS: 3600 },
      agentsDir: `/srv/${r.agents}/agents`,
      sessionCwd: r.privateSession ? `${worktreeRoot}/_private/${r.channel}` : `${worktreeRoot}/${r.channel}`,
      worktreeRoot,
      privateSession: r.privateSession,
      containerName: `seance-${r.nick}-0011aabb-ccdd2233`,
      labels: { workspaces: "fedcba9876543210", agent: r.nick },
      kiroAgent: r.kiroAgent,
      forwardEnv: r.forwardEnv,
    };
  });

const FORBIDDEN = [
  "--privileged",
  "--cap-add",
  "--device",
  "-v",
  "--volume",
  "--pid",
  "--ipc",
  "--uts",
  "--userns=host",
  "--network=host",
  "--env-file",
  "--env-host",
  "--add-host",
  "--group-add",
  "--publish",
  "-p",
  "-P",
  "--expose",
];

const flagName = (a: string): string => (a.includes("=") ? a.slice(0, a.indexOf("=")) : a);

/** The argv up to the image: everything before the first element equal to the image. */
const split = (argv: readonly string[], image: string): { flags: readonly string[]; tail: readonly string[] } => {
  const at = argv.indexOf(image);
  return { flags: argv.slice(1, at), tail: argv.slice(at) };
};

describe("agent-sandbox properties", () => {
  it("P1 argv invariants", () => {
    fc.assert(
      fc.property(validInput, (input) => {
        const argv = buildPodmanRunArgs(input);
        expect(argv[0]).toBe("run");
        const { flags, tail } = split(argv, input.config.image);
        expect(tail).toEqual([input.config.image, "acp", "--agent", input.kiroAgent]);
        const once = flags.filter((a) => a.startsWith("-")).map(flagName).filter((n) => !["--label", "--tmpfs", "--mount", "-e"].includes(n));
        expect(new Set(once).size).toBe(once.length); // each single flag once
        for (const f of ["-i", "--rm", "--read-only", "--cap-drop", "--security-opt", "--pids-limit", "--memory", "--memory-swap", "--cpus", "--user", "--userns", "--pull", "--http-proxy", "--no-hosts", "--log-driver", "--timeout", "--stop-timeout", "--hostname", "--workdir", "--network", "--name"]) {
          expect(once).toContain(f);
        }
        const mounts = flags.filter((a) => a.startsWith("--mount="));
        expect(mounts).toHaveLength(3);
        expect(mounts[0]).toContain(`src=${input.sessionCwd},dst=${input.sessionCwd},`);
        expect(mounts[1]).toContain(`src=${input.agentsDir},dst=${input.agentsDir},`);
        expect(mounts[2]).toContain(`src=${input.config.authDir},dst=${F.AUTH_MOUNT_POINT},`);
        for (const m of mounts) {
          expect(m).toContain(`,${F.MOUNT_PROPAGATION},${F.MOUNT_NOSUID},${F.MOUNT_NODEV},`);
          expect(m.split(",").filter((o) => o.startsWith("relabel="))).toHaveLength(1);
        }
        expect(mounts[0]?.endsWith(input.privateSession ? F.MOUNT_RELABEL_PRIVATE : F.MOUNT_RELABEL_SHARED)).toBe(true);
        for (const a of flags) for (const bad of FORBIDDEN) expect(flagName(a)).not.toBe(bad);
        expect(argv.some((a) => a.includes("\0"))).toBe(false);
      }),
      RUNS,
    );
  });

  it("P2 no extra mounts", () => {
    const bad = fc.constantFrom(",", '"', "\0", "\r", "\n");
    fc.assert(
      fc.property(validInput, bad, fc.constantFrom("sessionCwd", "agentsDir", "authDir"), (input, ch, where) => {
        const good = buildPodmanRunArgs(input).filter((a) => a.startsWith("--mount="));
        expect(good).toHaveLength(3);
        const broken: PodmanRunInput =
          where === "authDir"
            ? { ...input, config: { ...input.config, authDir: `${input.config.authDir}${ch}x` } }
            : where === "agentsDir"
              ? { ...input, agentsDir: `${input.agentsDir}${ch}x` }
              : { ...input, sessionCwd: `${input.sessionCwd}${ch}x` };
        let argv: readonly string[] | undefined;
        try {
          argv = buildPodmanRunArgs(broken);
        } catch (err) {
          expect(err).toBeInstanceOf(SandboxError);
          expect((err as SandboxError).kind).toBe("invalid-input");
        }
        expect(argv).toBeUndefined();
      }),
      RUNS,
    );
  });

  it("P3 environment and secrets", () => {
    fc.assert(
      fc.property(validInput, fc.stringMatching(/^[A-Za-z0-9]{12,40}$/), (input, secret) => {
        const argv = buildPodmanRunArgs(input);
        const env: string[] = [];
        argv.forEach((a, i) => {
          if (a === "-e") env.push(argv[i + 1] ?? "");
        });
        for (const e of env) {
          const ok = e === `HOME=${F.CONTAINER_HOME}` || e === `TMPDIR=${F.CONTAINER_TMP}` || input.forwardEnv.includes(e);
          expect(ok).toBe(true);
          expect(e.startsWith("KIRO_API_KEY")).toBe(false);
        }
        expect(argv.some((a) => a.includes(secret))).toBe(false);
        // Asking to forward the credential throws, and the error and the notice never carry the secret.
        try {
          buildPodmanRunArgs({ ...input, forwardEnv: [...input.forwardEnv, "KIRO_API_KEY"] });
          expect.unreachable();
        } catch (err) {
          expect(err).toBeInstanceOf(SandboxError);
          expect((err as Error).message).not.toContain(secret);
          expect(sandboxNotice("coder", "#dev", err as SandboxError)).not.toContain(secret);
        }
      }),
      RUNS,
    );
  });

  it("P4 injection resistance", () => {
    fc.assert(
      fc.property(validInput, fc.string({ maxLength: 30 }), (input, agent) => {
        const valid = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(agent);
        let argv: readonly string[] | undefined;
        try {
          argv = buildPodmanRunArgs({ ...input, kiroAgent: agent });
        } catch (err) {
          expect(err).toBeInstanceOf(SandboxError);
        }
        expect(argv !== undefined).toBe(valid);
        if (argv === undefined) return;
        const { flags } = split(argv, input.config.image);
        for (let i = 0; i < flags.length; i++) {
          const a = flags[i] ?? "";
          if (flags[i - 1] === "-e") continue; // a value, checked by P3
          if (a.startsWith("-")) expect(FIXED_FLAGS).toContain(flagName(a));
        }
        expect(argv.at(-1)).toBe(agent);
      }),
      RUNS,
    );
  });
});
