// Task 9.4: Session (effects runner) against the FakeHarness and a ManualClock.
// Time is virtual on both sides: `ManualClock` for the Session's timers, `harness.advance` for the
// Fake_Agent's own clock. No wall-clock sleeps.
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { TimerSet } from "../src/clock.js";
import type { AgentProfile } from "../src/registry/agent-profile.js";
import type { Prompt } from "../src/session/machine.js";
import { QUEUE_BOUND } from "../src/session/machine.js";
import { Session, type SinkDropReason } from "../src/session/session.js";
import { WhoisSnapshot } from "../src/whois/snapshot.js";
import type { FakeScript } from "./fixtures/fake-agent.js";
import { FakeHarness } from "./fixtures/fake-harness.js";
import { ManualClock } from "./fixtures/manual-clock.js";

const CHANNEL = "#dev";
const AGENT = "Ghost";
const PROFILE: AgentProfile = {
  nick: AGENT,
  kiroAgent: "ghost",
  model: "claude-haiku-5.5",
  tools: "read",
  color: 3,
  file: "ghost.json",
};

const SLOW = { match: "SLOW", steps: [{ gate: "g1" }, { chunk: "done" }] } as const;
const OK = { steps: [{ chunk: "ok" }] } as const;

type Dropped = { readonly prompt: Prompt; readonly why: SinkDropReason };

type Env = {
  readonly harness: FakeHarness;
  readonly clock: ManualClock;
  readonly session: Session;
  readonly snapshot: WhoisSnapshot;
  readonly dropped: Dropped[];
  readonly notices: string[];
  send(text: string): void;
  /** Advance both virtual clocks (agent first, so the settle window is over), then drain microtasks. */
  tick(ms: number): Promise<void>;
};

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of disposers.splice(0)) await fn();
});

/** Drains promise continuations (gate check, prompt resolution) without any timer. */
async function flush(): Promise<void> {
  for (let i = 0; i < 25; i++) await Promise.resolve();
}

async function setup(script: FakeScript, blocked: () => boolean = () => false): Promise<Env> {
  const harness = new FakeHarness({ defaultScript: script });
  disposers.push(() => harness.dispose());
  const harnessSession = await harness.openSession(PROFILE, {
    cwd: "/tmp/seance-fake-worktree",
    onPermission: async () => ({ cancelled: true }),
  });
  const clock = new ManualClock();
  const snapshot = new WhoisSnapshot();
  const dropped: Dropped[] = [];
  const notices: string[] = [];
  const session = new Session({
    agent: AGENT,
    channel: CHANNEL,
    harnessSession,
    snapshot,
    timers: new TimerSet(clock),
    gate: { check: async () => ({ ok: true }) },
    sink: { dropped: (prompt, why) => void dropped.push({ prompt, why }) },
    opNotice: (_channel, text) => void notices.push(text),
    isBlocked: blocked,
  });
  let nextId = 1;
  return {
    harness,
    clock,
    session,
    snapshot,
    dropped,
    notices,
    send: (text) => session.enqueue({ id: nextId++, text }),
    tick: async (ms) => {
      harness.advance(ms);
      clock.advance(ms);
      await flush();
    },
  };
}

const snapState = (env: Env): string | undefined =>
  env.snapshot.get(AGENT)?.channels.get(CHANNEL)?.state;
const sentTexts = (env: Env): string[] => env.harness.prompts.map((p) => p.text);

/** Starts a SLOW turn, cancels it and lets the cancelled result arrive: Session is in `cooldown`. */
async function intoCooldown(env: Env): Promise<void> {
  env.send("SLOW first");
  await flush();
  expect(env.session.state).toBe("prompting");
  env.session.cancel();
  await flush();
  expect(env.session.state).toBe("cooldown");
}

describe("Session cooldown", () => {
  it("holds the next prompt for 1000 ms after a cancelled turn", async () => {
    const env = await setup({ turns: [SLOW, OK] });
    await intoCooldown(env);
    env.send("next");
    await env.tick(999);
    expect(env.session.state).toBe("cooldown");
    expect(sentTexts(env)).toEqual(["SLOW first"]);

    await env.tick(1);
    expect(sentTexts(env)).toEqual(["SLOW first", "next"]);
    expect(env.session.state).toBe("idle");
    expect(env.clock.pending).toBe(0);
    expect(env.notices).toEqual([]);
  });

  it("ends the cooldown early on a metadata event with turnDurationMs, and clears the timer", async () => {
    const env = await setup({ turns: [SLOW, OK], settleMs: 500, metadataAfterCancel: true });
    await intoCooldown(env);
    env.send("next");
    expect(env.clock.pending).toBe(1);

    env.harness.advance(500); // Fake_Agent emits metadata at the end of its settle window
    await flush();
    expect(sentTexts(env)).toEqual(["SLOW first", "next"]);
    expect(env.session.state).toBe("idle");
    expect(env.clock.pending).toBe(0);

    // The cleared timer cannot fire a second cooldown-elapsed later.
    await env.tick(1000);
    expect(sentTexts(env)).toEqual(["SLOW first", "next"]);
  });

  it("never sends a prompt during cooldown after cancel-then-reuse (the cancel race)", async () => {
    const env = await setup({ turns: [SLOW, OK] });
    await intoCooldown(env);
    env.send("a");
    env.send("b");
    await flush();
    expect(env.harness.prompts).toHaveLength(1);
    await env.tick(500);
    expect(env.harness.prompts).toHaveLength(1);

    await env.tick(500);
    // Neither queued prompt was answered "cancelled" by the Fake_Agent's settle logic.
    expect(sentTexts(env)).toEqual(["SLOW first", "a", "b"]);
    expect(env.session.state).toBe("idle");
    expect(env.dropped).toEqual([]);
    expect(env.notices).toEqual([]);
  });
});

describe("Session notices and drops", () => {
  it("tells the ops when a prompt fails (agent exits mid-turn)", async () => {
    const env = await setup({ turns: [SLOW, OK] });
    env.send("SLOW boom");
    await flush();
    env.harness.simulateExit(AGENT, 1);
    await flush();
    expect(env.notices).toHaveLength(1);
    expect(env.notices[0]).toMatch(/^Ghost: prompt failed: .*exited/);
    expect(env.session.state).toBe("idle");
  });

  it("tells the ops about an unusual stop reason", async () => {
    const env = await setup({ turns: [{ steps: [{ stop: "max_tokens" }] }] });
    env.send("hello");
    await flush();
    expect(env.notices).toEqual(["Ghost: prompt ended with stop reason other"]);
    expect(env.session.state).toBe("idle");
  });

  it("drops the oldest queued prompt with one notice when the queue overflows", async () => {
    const env = await setup({ turns: [SLOW, OK] });
    env.send("SLOW head"); // id 1, in flight
    await flush();
    for (let i = 0; i < QUEUE_BOUND; i++) env.send(`q${String(i)}`); // ids 2..21 fill the queue
    expect(env.dropped).toEqual([]);
    expect(env.notices).toEqual([]);

    env.send("overflow"); // id 22
    expect(env.dropped).toEqual([{ prompt: { id: 2, text: "q0" }, why: "overflow" }]);
    expect(env.notices).toEqual(["Ghost: queue full, dropped oldest prompt #2: q0"]);
    expect(env.harness.prompts).toHaveLength(1);
  });

  it("turns enqueue into a credit-blocked drop before the reducer", async () => {
    const env = await setup({ turns: [OK] }, () => true);
    env.send("hello");
    await flush();
    expect(env.dropped).toEqual([{ prompt: { id: 1, text: "hello" }, why: "credit-blocked" }]);
    expect(env.harness.prompts).toHaveLength(0);
    expect(env.session.state).toBe("idle");
  });
});

describe("Session closed", () => {
  it("drops queued prompts and rejects new ones once closed", async () => {
    const env = await setup({ turns: [SLOW, OK] });
    env.send("SLOW head");
    await flush();
    env.send("queued");
    env.session.close("shutdown");
    expect(env.session.state).toBe("closed");
    expect(env.dropped).toEqual([{ prompt: { id: 2, text: "queued" }, why: "closed" }]);

    env.send("late");
    expect(env.dropped.at(-1)).toEqual({ prompt: { id: 3, text: "late" }, why: "closed" });
    expect(env.harness.prompts).toHaveLength(1);

    // The in-flight turn ending afterwards does not revive the Session.
    env.harness.release(AGENT, "g1");
    await flush();
    expect(env.session.state).toBe("closed");
    expect(snapState(env)).toBe("closed");
    expect(env.clock.pending).toBe(0);
  });
});

describe("Session snapshot", () => {
  it("is updated synchronously with every state change", async () => {
    const env = await setup({ turns: [SLOW, OK] });
    expect(snapState(env)).toBe("idle");

    env.send("SLOW one");
    expect(snapState(env)).toBe("prompting"); // before any await
    env.session.cancel();
    expect(snapState(env)).toBe("cancelling");

    await flush();
    expect(snapState(env)).toBe("cooldown");
    await env.tick(1000);
    expect(snapState(env)).toBe("idle");

    env.session.close("exorcism");
    expect(snapState(env)).toBe("closed");
  });
});

describe("P1 harness-side counts", () => {
  it("sends one cancel per in-flight turn and no prompt during cooldown", async () => {
    const env = await setup({ turns: [SLOW, OK] });
    env.session.cancel(); // idle: nothing in flight, nothing sent
    await flush();
    expect(env.harness.cancels).toHaveLength(0);

    await intoCooldown(env);
    env.session.cancel(); // cooldown: ignored
    env.send("next");
    await flush();
    expect(env.harness.cancels).toEqual([
      { agent: AGENT, sessionId: env.session.acpSessionId, inFlight: true },
    ]);
    expect(env.harness.prompts).toHaveLength(1);

    await env.tick(1000);
    expect(env.harness.prompts).toHaveLength(2);
    expect(env.harness.cancels).toHaveLength(1);
    expect(env.harness.coreOf(AGENT)?.dump().cancelCount).toBe(1);
  });

  it("holds for arbitrary operation sequences", async () => {
    const op = fc.constantFrom("send", "cancel", "tick1000", "tick300");
    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 30 }), async (ops) => {
        const env = await setup({ turns: [SLOW, OK] });
        let sent = 0;
        for (const o of ops) {
          if (o === "send") {
            env.send(`SLOW ${String(sent++)}`);
            await flush();
          } else if (o === "cancel") {
            env.session.cancel();
            await flush();
          } else {
            await env.tick(o === "tick1000" ? 1000 : 300);
          }
          // Cancels only ever target a turn in flight, and match what the Fake_Agent saw.
          expect(env.harness.cancels.every((c) => c.inFlight)).toBe(true);
          expect(env.harness.coreOf(AGENT)?.dump().cancelCount).toBe(env.harness.cancels.length);
          expect(env.harness.prompts.length).toBeLessThanOrEqual(sent);
          // At most one prompt is outstanding: every cancel was sent for a distinct turn.
          expect(env.harness.cancels.length).toBeLessThanOrEqual(env.harness.prompts.length);
        }
        await env.harness.dispose();
      }),
      { numRuns: 50 },
    );
  });
});
