import { afterEach, describe, expect, it } from "vitest";
import { closeAllFixtures, startIntegration } from "./integration.js";
import type { IrcTestClient } from "./integration.js";

// agent-runner Requirement 3.21 to 3.24: a message sent while the agent's Session is still being
// created is queued and answered once `session/new` completes. The Fake_Agent answers `session/new`
// after a real delay, like a cold kiro-cli start.

const CHANNEL = "#wake";
const TEST_TIMEOUT_MS = 30_000;
const SESSION_NEW_DELAY_MS = 1_500;

afterEach(async () => {
  await closeAllFixtures();
});

const turn = (match: string, ...chunks: readonly string[]): { match: string; steps: { chunk: string }[] } => ({
  match,
  steps: chunks.map((chunk) => ({ chunk })),
});

/** Invites coder and returns as soon as it has joined: its Session does not exist yet. */
async function inviteAndJoin(op: IrcTestClient): Promise<void> {
  await op.join(CHANNEL);
  op.send(`INVITE coder ${CHANNEL}`);
  await op.waitFor(/^:\S+ 341 \S+ coder /);
  await op.waitFor(new RegExp(`^:coder!\\S+ JOIN :?${CHANNEL}$`, "i"));
}

describe("startup queue (Fake_Agent with a slow session/new)", () => {
  it(
    "answers a message sent before the Session is ready, with one 'waking up' notice and a ready notice",
    async () => {
      const fx = await startIntegration({
        script: {
          sessionNewDelayMs: SESSION_NEW_DELAY_MS,
          turns: [
            turn("^\\[#wake\\] <@op1> hello there$", "I am awake."),
            turn("^\\[#wake\\] <@op1> still there\\?$", "Yes."),
          ],
        },
      });
      const op = await fx.connectClient("op1");
      await inviteAndJoin(op);
      expect(fx.logs.some((l) => l.msg === "agent joined channel")).toBe(false);

      op.send(`MODE ${CHANNEL} +v coder`);
      await op.waitFor(/MODE #wake \+v coder$/);
      op.send(`PRIVMSG ${CHANNEL} :hello there`);
      op.send(`PRIVMSG ${CHANNEL} :still there?`);

      await op.waitFor(/^:coder!\S+ NOTICE #wake :coder is still waking up, your message is queued$/);
      // The ready notice is sent right after the queue is handed over, so it precedes the reply.
      await op.waitFor(/^:ChanServ!\S+ NOTICE #wake :coder is ready$/, 15_000);
      await op.waitFor(/PRIVMSG #wake :\x0312I am awake\.\x0F$/, 15_000);
      // The second queued message is delivered after the first, in order.
      // One word: the trailing parameter is serialised without `:`.
      await op.waitFor(/PRIVMSG #wake :?\x0312Yes\.\x0F$/, 15_000);

      // Exactly one "waking up" notice per startup, and no message was ignored for lack of a Session.
      expect(op.lines.filter((l) => l.includes("is still waking up"))).toHaveLength(1);
      expect(fx.logs.some((l) => l.msg === "event ignored" && l.fields?.["reason"] === "no Session in the channel")).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "drops the queue with a notice when the agent is kicked before it is ready",
    async () => {
      const fx = await startIntegration({
        script: { sessionNewDelayMs: SESSION_NEW_DELAY_MS, turns: [turn(".*", "should never be said")] },
      });
      const op = await fx.connectClient("op1");
      await inviteAndJoin(op);
      op.send(`MODE ${CHANNEL} +v coder`);
      await op.waitFor(/MODE #wake \+v coder$/);
      op.send(`PRIVMSG ${CHANNEL} :are you there`);
      await op.waitFor(/NOTICE #wake :coder is still waking up, your message is queued$/);

      op.send(`KICK ${CHANNEL} coder :too slow`);
      // Task 27.4: nick and count only, once per startup.
      await op.waitFor(/NOTICE #wake :coder dropped 1 queued message$/, 10_000);
      expect(op.lines.filter((l) => l.includes("queued message")).filter((l) => l.includes("dropped"))).toHaveLength(1);
      expect(await op.expectNone(/PRIVMSG #wake :\x0312should never be said/, 2_500)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});
