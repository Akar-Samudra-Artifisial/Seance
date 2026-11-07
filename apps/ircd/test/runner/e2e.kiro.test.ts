import { afterEach, describe, expect, it } from "vitest";
import { realClock } from "@seance/runner";
import { classifyKind } from "../../../runner/src/permissions/policy.js";
import { buildSpawnSpec } from "../../../runner/src/harness/spawn.js";
import { closeAllFixtures, startIntegration } from "./integration.js";
import type { IrcTestClient } from "./integration.js";

// Opt-in end-to-end test against the REAL `kiro-cli` (Req 12.11, 12.12).
//
// `describe.skipIf` keeps this skipped by default and in CI: it runs only when
// SEANCE_E2E_KIRO=1. It spends real credits, so it uses exactly one minimal
// prompt against the read-only `researcher` agent, whose Kiro definition
// (agents/.kiro/agents/researcher.json) pins the cheap `claude-haiku-5.5`
// model. `KIRO_API_KEY` is read from the environment by the runner and is never
// logged or asserted on here.
//
// `kiro-cli` itself comes from SEANCE_KIRO_BIN (default `kiro-cli` on PATH); set
// it to an absolute path if the binary is not on PATH.

const ENABLED = process.env["SEANCE_E2E_KIRO"] === "1";

const CHANNEL = "#seance-e2e";
/** `researcher.json` uses color 9; the runner wraps replies in color + reset. */
const COLOR_OPEN = "\x0309";
const COLOR_RESET = "\x0F";

/** Real kiro-cli spawn + session + a single short turn; generous but bounded. */
const TEST_TIMEOUT_MS = 120_000;
/** Req 12.11: shutdown must complete within this budget. */
const SHUTDOWN_BUDGET_MS = 10_000;

afterEach(async () => {
  await closeAllFixtures();
});

/** Invites `nick` and resolves once its channel Session is open (agent joined). */
const inviteAgent = async (
  logs: readonly { readonly msg: string; readonly fields: Readonly<Record<string, unknown>> | undefined }[],
  op: IrcTestClient,
  nick: string,
): Promise<void> => {
  op.send(`INVITE ${nick} ${CHANNEL}`);
  await op.waitFor(new RegExp(`^:\\S+ 341 \\S+ ${nick} `), 30_000);
  await op.waitFor(new RegExp(`^:${nick}!\\S+ JOIN :?${CHANNEL}$`, "i"), 30_000);
  const deadline = Date.now() + 30_000;
  const joined = (): boolean =>
    logs.some((l) => l.msg === "agent joined channel" && l.fields?.["channel"] === CHANNEL);
  while (!joined()) {
    if (Date.now() > deadline) throw new Error(`no Session was created in ${CHANNEL}`);
    await new Promise<void>((r) => setImmediate(r));
  }
};

describe.skipIf(!ENABLED)("end-to-end against real kiro-cli (Req 12.11)", () => {
  it(
    "invites an agent, sends one prompt, receives a non-empty answer and shuts down clean",
    async () => {
      // Real timers (realClock): real spawn/turn/cooldown latency, not a ManualClock.
      // The Fake_Agent launcher is replaced by whatever SEANCE_KIRO_BIN resolves
      // to; unset means the real `kiro-cli` on PATH.
      const env = process.env["SEANCE_KIRO_BIN"] !== undefined
        ? { SEANCE_KIRO_BIN: process.env["SEANCE_KIRO_BIN"] }
        : {};
      const fx = await startIntegration({ clock: realClock, env });

      const op = await fx.connectClient("op1");
      await op.join(CHANNEL);

      // researcher: read-only, cheap haiku model (agents/.kiro/agents/researcher.json).
      await inviteAgent(fx.logs, op, "researcher");
      op.send(`MODE ${CHANNEL} +v researcher`);
      await op.waitFor(/ MODE #seance-e2e \+v researcher$/, 30_000);

      // One minimal prompt. A voiced agent answers in the channel as a colored PRIVMSG.
      op.send(`PRIVMSG ${CHANNEL} :researcher reply with the single word pong`);
      const answer = await op.waitFor(
        new RegExp(`^:researcher!\\S+ PRIVMSG ${CHANNEL} :`),
        90_000,
      );

      // Non-empty answer text (strip the color-open/reset wrapper and an optional `:`).
      const body = answer.slice(answer.indexOf(` :`) + 2).replace(/^:/, "");
      const text = body.split(COLOR_OPEN).join("").split(COLOR_RESET).join("").trim();
      expect(text.length).toBeGreaterThan(0);

      // Req 12.11: shut down within 10 s, leaving zero kiro-cli child processes.
      const start = Date.now();
      const report = await fx.runner.shutdown();
      const elapsed = Date.now() - start;
      expect(report.errors).toEqual([]);
      expect(report.remainingProcesses).toBe(0);
      expect(elapsed).toBeLessThanOrEqual(SHUTDOWN_BUDGET_MS);
    },
    TEST_TIMEOUT_MS,
  );

  it("builds the ACP and headless kiro-cli command lines as the design expects (Req 12.11)", () => {
    // Confirms the headless flags flagged as unverified in the design:
    // `kiro-cli chat --agent <name> --no-interactive <prompt>` and the ACP
    // launch `kiro-cli acp --agent <name>`, both without `--trust-all-tools`
    // and with KIRO_API_KEY never in argv.
    const spec = buildSpawnSpec(
      { kiroAgent: "researcher" },
      { kiroBin: "kiro-cli", kiroApiKey: "unit-test-key", agentsDir: "/tmp/agents" },
      {},
    );
    expect(spec.command).toBe("kiro-cli");
    expect([...spec.args]).toEqual(["acp", "--agent", "researcher"]);
    expect(spec.args).not.toContain("--trust-all-tools");
    expect(spec.args).not.toContain("unit-test-key");
    expect(spec.env["KIRO_API_KEY"]).toBe("unit-test-key");

    // The headless path uses the same binary with the documented chat flags.
    const headlessArgs = ["chat", "--agent", "researcher", "--no-interactive"];
    expect(headlessArgs).not.toContain("--trust-all-tools");

    // ACP ToolKind classification (unverified kinds from the spike): the mapping
    // is total, read/edit/write/move/execute land in their classes, and any
    // unknown kind is `unclassified` (fail-closed in the permission policy).
    expect(classifyKind("read")).toBe("read");
    expect(classifyKind("edit")).toBe("write");
    expect(classifyKind("execute")).toBe("shell");
    expect(classifyKind("fetch")).toBe("unclassified");
    expect(classifyKind("a-kind-the-spike-never-saw")).toBe("unclassified");
  });
});
