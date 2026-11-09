import { afterEach, describe, expect, it } from "vitest";
import { ManualClock, closeAllFixtures, startIntegration } from "./integration.js";
import type { FakeAgentScript, IntegrationFixture, IrcTestClient } from "./integration.js";

// runner-services Requirement 11 end to end: two +v Fake_Agents in one channel, a real ircd and the
// real runner. The Fake_Agent answers every prompt; the loop guard must stop the exchange.

const CHANNEL = "#loop";
const TEST_TIMEOUT_MS = 40_000;
const QUIET_MS = 1_500;

let pump: ReturnType<typeof setInterval> | undefined;
afterEach(async () => {
  try {
    await closeAllFixtures();
  } finally {
    if (pump !== undefined) clearInterval(pump);
    pump = undefined;
  }
}, TEST_TIMEOUT_MS);

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const saidBy = (op: IrcTestClient, nick: string): readonly string[] =>
  op.lines.filter((l) => new RegExp(`^:${escapeRegExp(nick)}![^ ]+ PRIVMSG ${escapeRegExp(CHANNEL)} `).test(l));

/** `count` turns that each answer with the same text. */
const repeat = (text: string, count: number): FakeAgentScript => ({
  turns: Array.from({ length: count }, () => ({ steps: [{ chunk: text }] })),
});

async function scene(script: FakeAgentScript): Promise<{ fx: IntegrationFixture; op: IrcTestClient }> {
  const clock = new ManualClock();
  const fx = await startIntegration({ clock, script });
  // Cooldowns and queued turns run on the ManualClock: keep it moving for the whole test.
  pump = setInterval(() => clock.advance(100), 5);
  const op = await fx.connectClient("op");
  await op.join(CHANNEL);
  for (const agent of ["coder", "reviewer"]) {
    op.send(`INVITE ${agent} ${CHANNEL}`);
    await op.waitFor(new RegExp(`^:${agent}!\\S+ JOIN :?${escapeRegExp(CHANNEL)}$`, "i"), 15_000);
    const deadline = Date.now() + 15_000;
    while (!fx.logs.some((l) => l.msg === "agent joined channel" && l.fields?.["agent"] === agent)) {
      if (Date.now() > deadline) throw new Error(`${agent} never got a Session`);
      await new Promise<void>((r) => setImmediate(r));
    }
    op.send(`MODE ${CHANNEL} +v ${agent}`);
    await op.waitFor(new RegExp(`MODE ${escapeRegExp(CHANNEL)} \\+v ${agent}$`));
  }
  return { fx, op };
}

/** Waits until the agents have been quiet for QUIET_MS (no new PRIVMSG from either). */
async function settle(op: IrcTestClient): Promise<void> {
  let seen = -1;
  for (;;) {
    const now = saidBy(op, "coder").length + saidBy(op, "reviewer").length;
    if (now === seen) return;
    seen = now;
    await op.expectNone(() => false, QUIET_MS);
  }
}

describe("agent-to-agent loop guard (Fake_Agent + in-process ircd)", () => {
  it(
    "stops an 'ok' / 'ok' exchange after the first round when the agents do not mention each other",
    async () => {
      const { op } = await scene(repeat("ok", 20));
      op.send(`PRIVMSG ${CHANNEL} :hello both`);
      await op.waitFor(/^:coder!\S+ PRIVMSG #loop /, 15_000);
      await settle(op);
      // Each agent answered the human once; "ok" names nobody, so no agent prompted the other.
      expect(saidBy(op, "coder")).toHaveLength(1);
      expect(saidBy(op, "reviewer")).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "stops mutual mentions after AGENT_REPLY_LIMIT (3) replies each, and a new human line allows one more bounded round",
    async () => {
      const { fx, op } = await scene(repeat("ok coder, ok reviewer", 20));
      op.send(`PRIVMSG ${CHANNEL} :start`);
      await op.waitFor(/^:reviewer!\S+ PRIVMSG #loop /, 15_000);
      await settle(op);
      // 1 reply to the human + 3 replies to the other agent, each.
      expect(saidBy(op, "coder")).toHaveLength(4);
      expect(saidBy(op, "reviewer")).toHaveLength(4);
      expect(fx.logs.filter((l) => l.msg === "agent reply limit reached")).toHaveLength(2);
      // The guard says nothing on IRC.
      expect(op.lines.some((l) => /limit/i.test(l))).toBe(false);

      // Req 11.4 (amended by review finding 1): a member without +v or +o does not reset the counts.
      // Changed by public-hardening Requirement 4: the lurker's line no longer prompts the agents at
      // all (each used to answer it once, making 5), so the counts stay at 4.
      const lurker = await fx.connectClient("lurker");
      await lurker.join(CHANNEL);
      lurker.send(`PRIVMSG ${CHANNEL} :anyone here`);
      await op.waitFor(/^:lurker!\S+ PRIVMSG #loop /, 15_000);
      await settle(op);
      expect(saidBy(op, "coder")).toHaveLength(4);
      expect(saidBy(op, "reviewer")).toHaveLength(4);
      expect(fx.logs.some((l) => l.msg === "no prompt: sender has no mode and is not the inviter")).toBe(true);

      // The op (+o) resets them: one reply to the op plus a full bounded round of 3, each.
      // Expected counts: 4 + 1 + 3 = 8 (9 while the lurker still prompted the agents).
      op.send(`PRIVMSG ${CHANNEL} :once more`);
      await settle(op);
      expect(saidBy(op, "coder")).toHaveLength(8);
      expect(saidBy(op, "reviewer")).toHaveLength(8);
    },
    TEST_TIMEOUT_MS,
  );
});
