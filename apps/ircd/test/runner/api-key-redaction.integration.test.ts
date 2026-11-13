// KIRO_API_KEY redaction (sandbox-api-key-auth Requirement 13.9, 13.10; tasks 16.1 and 9.2):
// every agent output path that reaches IRC goes through the runner's shared SecretRedactor, so
// neither the raw key nor its base64 form is ever visible to a client.
//
// Paths driven through the Fake_Agent (all end in AgentOutput, which owns the shared redactor):
//   (a) agent message text   -> PRIVMSG  (AgentOutput.say)
//   (b) tool call title      -> NOTICE   (AgentOutput.toolStarted -> channelNotice) and AWAY text
//   (c) a secret split over two message chunks (continuation matching in the same channel)
// Not drivable: a prompt error message. The Fake_Agent cannot send an arbitrary JSON-RPC error text
// (only fixed ones), and a `stop` reason never reaches IRC (the notice only names the reason class).
// Error text from a real agent passes through AcpClient.safe(), which redacts the same key.
import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { ManualClock, closeAllFixtures, startIntegration } from "./integration.js";
import type { LogRecord } from "./integration.js";

const CHANNEL = "#haunt";
const TEST_TIMEOUT_MS = 30_000;

// A generated placeholder, never a real key.
const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const API_KEY = `ksk_test_${Array.from({ length: 24 }, (_, i) => ALNUM[(i * 7 + 3) % ALNUM.length]).join("")}`;
const API_KEY_B64 = Buffer.from(API_KEY).toString("base64");
const HALF = Math.floor(API_KEY.length / 2);

const clocks = new Set<ManualClock>();

afterEach(async () => {
  const pump = setInterval(() => {
    for (const c of clocks) c.advance(1_000);
  }, 10);
  try {
    await closeAllFixtures();
  } finally {
    clearInterval(pump);
    clocks.clear();
  }
}, TEST_TIMEOUT_MS);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const logged = (logs: readonly LogRecord[], pred: (r: LogRecord) => boolean): LogRecord | undefined => logs.find(pred);

describe("KIRO_API_KEY redaction on every agent output path", { timeout: TEST_TIMEOUT_MS }, () => {
  it("never shows the raw key or its base64 form on IRC", async () => {
    const clock = new ManualClock();
    clocks.add(clock);
    const f = await startIntegration({
      clock,
      env: { KIRO_API_KEY: API_KEY },
      script: {
        turns: [
          {
            steps: [
              { chunk: `leak-text: raw ${API_KEY} b64 ${API_KEY_B64}\n` },
              { toolCall: { kind: "execute", title: `leak-tool: ${API_KEY} ${API_KEY_B64}`, command: `echo ${API_KEY}` } },
              { chunk: `leak-split: ${API_KEY.slice(0, HALF)}` },
              { chunk: `${API_KEY.slice(HALF)}\n` },
              { chunk: "leak-done\n" },
            ],
          },
        ],
      },
    });
    try {
      const op = await f.connectClient("op");
      await op.join(CHANNEL);
      op.send(`INVITE coder ${CHANNEL}`);
      await op.waitFor(/^:\S+ 341 /);
      const deadline = Date.now() + 10_000;
      while (!logged(f.logs, (r) => r.msg === "agent joined channel" && r.fields?.["channel"] === CHANNEL)) {
        if (Date.now() > deadline) throw new Error("timed out waiting for the coder session");
        await sleep(10);
      }
      op.send(`MODE ${CHANNEL} +o coder`);
      await op.waitFor(new RegExp(`^:op!\\S+ MODE ${CHANNEL} \\+o coder`, "i"));

      op.send(`PRIVMSG ${CHANNEL} :go`);
      await op.waitFor(/^:coder!\S+ PRIVMSG \S+ :?.*leak-done/, 15_000);
      await sleep(300); // let any trailing line arrive

      const lines = op.lines;
      const text = lines.filter((l) => /^:coder!\S+ PRIVMSG /.test(l));
      const tool = lines.filter((l) => /^:coder!\S+ NOTICE /.test(l));

      // Not vacuous: each path produced a line, with the surrounding marker intact.
      expect(text.some((l) => l.includes("leak-text:"))).toBe(true);
      expect(tool.some((l) => l.includes("leak-tool:"))).toBe(true);
      expect(text.some((l) => l.includes("leak-split:"))).toBe(true);

      for (const line of lines) {
        expect(line).not.toContain(API_KEY);
        expect(line).not.toContain(API_KEY_B64);
      }
      // The split key must not be reassembled from its halves either.
      expect(lines.join("\n")).not.toContain(API_KEY.slice(HALF));
    } finally {
      await rm(f.workspaces, { recursive: true, force: true });
    }
  });
});
