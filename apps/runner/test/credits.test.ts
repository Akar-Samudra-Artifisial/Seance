// Task 13.7: unit tests for the CreditLedger, the `!reset-credits` handler and their wiring into
// Session and SessionManager (Req 10.3, 10.9, 10.10, 10.11, 10.12, 10.14, 10.16). Time is a ManualClock.
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimerSet } from "../src/clock.js";
import {
  CreditLedger,
  LEDGER_FLUSH_MS,
  type CancellableSession,
  type CreditLedgerDeps,
} from "../src/credits/ledger.js";
import { createResetCreditsHandler, isResetCreditsCommand } from "../src/credits/reset-command.js";
import type { LogFields, RunnerLogger } from "../src/log.js";
import type { HostMembership } from "../src/ports.js";
import type { AgentProfile } from "../src/registry/agent-profile.js";
import type { Prompt } from "../src/session/machine.js";
import { Session, type SinkDropReason } from "../src/session/session.js";
import { SessionManager, type SessionManagerDeps } from "../src/session/session-manager.js";
import type { SessionRecord, SessionStore } from "../src/session/session-store.js";
import { WhoisSnapshot } from "../src/whois/snapshot.js";
import { FakeHarness } from "./fixtures/fake-harness.js";
import { ManualClock } from "./fixtures/manual-clock.js";

const AGENT = "Ghost";
const CHANNEL = "#dev";

type LogEntry = { readonly msg: string; readonly fields: LogFields | undefined };

function makeLogger(): { readonly logger: RunnerLogger; readonly errors: LogEntry[] } {
  const errors: LogEntry[] = [];
  const noop = (): void => undefined;
  return {
    errors,
    logger: {
      debug: noop,
      info: noop,
      warn: noop,
      error: (msg, fields) => void errors.push({ msg, fields }),
    },
  };
}

class MemoryStore implements SessionStore {
  readonly puts: SessionRecord[] = [];
  failures = 0;
  readonly #records = new Map<string, SessionRecord>();

  get(agent: string, channel: string): Promise<SessionRecord | undefined> {
    return Promise.resolve(this.#records.get(`${agent}\0${channel}`));
  }

  put(record: SessionRecord): Promise<void> {
    if (this.failures > 0) {
      this.failures -= 1;
      return Promise.reject(new Error("store unavailable"));
    }
    this.puts.push(record);
    this.#records.set(`${record.agent}\0${record.channel}`, record);
    return Promise.resolve();
  }

  list(): Promise<readonly SessionRecord[]> {
    return Promise.resolve([...this.#records.values()]);
  }
}

type LedgerEnv = {
  ledger: CreditLedger;
  readonly store: MemoryStore;
  readonly clock: ManualClock;
  readonly snapshot: WhoisSnapshot;
  readonly notices: { readonly channel: string; readonly text: string }[];
  readonly errors: LogEntry[];
  sessions: CancellableSession[];
};

function makeLedger(opts: { readonly cap?: number } = {}): LedgerEnv {
  const store = new MemoryStore();
  const clock = new ManualClock();
  const snapshot = new WhoisSnapshot();
  const notices: { channel: string; text: string }[] = [];
  const { logger, errors } = makeLogger();
  const env: LedgerEnv = {
    store,
    clock,
    snapshot,
    notices,
    errors,
    sessions: [],
    ledger: undefined as unknown as CreditLedger,
  };
  const deps: CreditLedgerDeps = {
    store,
    snapshot,
    clock,
    logger,
    ...(opts.cap !== undefined ? { cap: opts.cap } : {}),
    sessionsOf: () => env.sessions,
    opNotice: (channel, text) => void notices.push({ channel, text }),
  };
  env.ledger = new CreditLedger(deps);
  return env;
}

/** Lets the ledger's chained flush promises run without waiting on a clock. */
const settle = (): Promise<void> => vi.waitFor(() => undefined);

describe("CreditLedger persistence (Req 10.3)", () => {
  it("writes one coalesced record within 1000 ms of the first change", async () => {
    const env = makeLedger();
    env.ledger.add(AGENT, CHANNEL, 1.5);
    env.ledger.add(AGENT, CHANNEL, 0.25);
    env.ledger.add(AGENT, CHANNEL, 0.25);

    expect(LEDGER_FLUSH_MS).toBeLessThan(1000);
    env.clock.advance(LEDGER_FLUSH_MS - 1);
    await settle();
    expect(env.store.puts).toHaveLength(0);

    env.clock.advance(1);
    await vi.waitFor(() => expect(env.store.puts).toHaveLength(1));
    expect(env.store.puts[0]).toMatchObject({
      agent: "ghost",
      channel: "#dev",
      creditsUsed: 2,
      updatedAt: LEDGER_FLUSH_MS,
    });
    expect(env.clock.pending).toBe(0);
  });

  it("updates sums and the WhoisSnapshot synchronously, before any store write", () => {
    const env = makeLedger();
    env.ledger.add(AGENT, CHANNEL, 2);
    env.ledger.add("Wraith", "#DEV", 3);

    expect(env.ledger.amount("GHOST", "#Dev")).toBe(2);
    expect(env.ledger.channelTotal("#dev")).toBe(5);
    expect(env.ledger.agentTotal("ghost")).toBe(2);
    expect(env.snapshot.get(AGENT)?.channels.get("#dev")?.credits).toBe(2);
    expect(env.snapshot.get(AGENT)?.total).toBe(2);
    expect(env.store.puts).toHaveLength(0);
  });

  it("logs a failing store write and retries it on the next change", async () => {
    const env = makeLedger();
    env.store.failures = 1;
    env.ledger.add(AGENT, CHANNEL, 1);
    env.clock.advance(LEDGER_FLUSH_MS);

    await vi.waitFor(() => expect(env.errors).toHaveLength(1));
    expect(env.errors[0]?.msg).toBe("persisting credits failed");
    expect(String(env.errors[0]?.fields?.["error"])).toContain("store unavailable");
    expect(env.store.puts).toHaveLength(0);
    // In-memory credits are unaffected by the failure.
    expect(env.ledger.amount(AGENT, CHANNEL)).toBe(1);

    env.ledger.add(AGENT, CHANNEL, 1);
    env.clock.advance(LEDGER_FLUSH_MS);
    await vi.waitFor(() => expect(env.store.puts).toHaveLength(1));
    expect(env.store.puts[0]?.creditsUsed).toBe(2);
    expect(env.errors).toHaveLength(1);
  });

  it("flush() retries a failed write immediately and clears the timer", async () => {
    const env = makeLedger();
    env.store.failures = 1;
    env.ledger.add(AGENT, CHANNEL, 4);
    await env.ledger.flush();
    expect(env.clock.pending).toBe(0);
    expect(env.errors).toHaveLength(1);

    await env.ledger.flush();
    expect(env.store.puts.map((r) => r.creditsUsed)).toEqual([4]);
  });

  it("restores persisted totals", async () => {
    const env = makeLedger();
    await env.store.put({
      agent: "ghost",
      channel: "#dev",
      acpSessionId: undefined,
      status: "closed",
      creditsUsed: 7,
      updatedAt: 1,
    });
    await env.ledger.restore();
    expect(env.ledger.amount(AGENT, CHANNEL)).toBe(7);
    expect(env.ledger.channelTotal(CHANNEL)).toBe(7);
  });
});

describe("CreditLedger cap (Req 10.9)", () => {
  it("rejects a cap that is not a finite number greater than 0", () => {
    expect(() => makeLedger({ cap: 0 })).toThrow(RangeError);
    expect(() => makeLedger({ cap: Number.NaN })).toThrow(RangeError);
  });

  it("does not block at the cap, only above it", () => {
    const env = makeLedger({ cap: 10 });
    env.ledger.add(AGENT, CHANNEL, 10);
    expect(env.ledger.isBlocked(CHANNEL)).toBe(false);
    expect(env.notices).toHaveLength(0);
    env.ledger.add(AGENT, CHANNEL, 0.5);
    expect(env.ledger.isBlocked("#DEV")).toBe(true);
  });

  it("cancels every prompting session of the channel and sends one op notice", () => {
    const env = makeLedger({ cap: 10 });
    const cancelled: string[] = [];
    const fake = (agent: string, state: CancellableSession["state"]): CancellableSession => ({
      agent,
      state,
      cancel: () => void cancelled.push(agent),
    });
    env.sessions = [fake("Ghost", "prompting"), fake("Wraith", "idle"), fake("Imp", "prompting")];

    env.ledger.add("Wraith", CHANNEL, 6);
    env.ledger.add(AGENT, CHANNEL, 4.5);

    expect(cancelled).toEqual(["Ghost", "Imp"]);
    expect(env.notices).toEqual([
      { channel: CHANNEL, text: "credit cap reached for #dev: 10.50 / 10.00" },
    ]);

    // Already blocked: further credits neither cancel again nor notify again.
    env.ledger.add(AGENT, CHANNEL, 1);
    expect(cancelled).toEqual(["Ghost", "Imp"]);
    expect(env.notices).toHaveLength(1);
  });

  it("keeps cancelling the other sessions when one cancel throws", () => {
    const env = makeLedger({ cap: 1 });
    const cancelled: string[] = [];
    env.sessions = [
      {
        agent: "Ghost",
        state: "prompting",
        cancel: () => {
          throw new Error("boom");
        },
      },
      { agent: "Imp", state: "prompting", cancel: () => void cancelled.push("Imp") },
    ];
    env.ledger.add(AGENT, CHANNEL, 2);
    expect(cancelled).toEqual(["Imp"]);
    expect(env.errors.map((e) => e.msg)).toEqual(["cancel after credit cap failed"]);
    expect(env.notices).toHaveLength(1);
  });

  it("never blocks without a cap", () => {
    const env = makeLedger();
    env.ledger.add(AGENT, CHANNEL, 1e6);
    expect(env.ledger.isBlocked(CHANNEL)).toBe(false);
    expect(env.notices).toHaveLength(0);
  });
});

describe("Session and the credit block (Req 10.9, 10.10)", () => {
  const PROFILE: AgentProfile = {
    nick: AGENT,
    kiroAgent: "ghost",
    model: "claude-haiku-5.5",
    tools: "read",
    color: 3,
    file: "ghost.json",
  };
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
  });

  async function setup(cap: number) {
    const env = makeLedger({ cap });
    const harness = new FakeHarness({
      defaultScript: {
        turns: [{ match: "SLOW", steps: [{ gate: "g1" }, { chunk: "done" }] }, { steps: [{ chunk: "ok" }] }],
      },
    });
    cleanups.push(() => harness.dispose());
    const dropped: { readonly prompt: Prompt; readonly why: SinkDropReason }[] = [];
    const timers = new TimerSet(env.clock);
    const open = async (): Promise<Session> => {
      const harnessSession = await harness.openSession(PROFILE, {
        cwd: "/tmp/unused",
        onPermission: () => Promise.resolve({ cancelled: true }),
      });
      return new Session({
        agent: AGENT,
        channel: CHANNEL,
        harnessSession,
        snapshot: env.snapshot,
        timers,
        gate: { check: () => Promise.resolve({ ok: true }) },
        sink: { dropped: (prompt, why) => void dropped.push({ prompt, why }) },
        opNotice: () => undefined,
        isBlocked: (c) => env.ledger.isBlocked(c),
      });
    };
    return { env, harness, dropped, open };
  }

  it("cancels an in-flight prompt when the cap is exceeded, then drops new prompts", async () => {
    const { env, harness, dropped, open } = await setup(5);
    const session = await open();
    env.sessions = [session];

    session.enqueue({ id: 1, text: "SLOW work" });
    await vi.waitFor(() => expect(session.state).toBe("prompting"));
    await vi.waitFor(() => expect(harness.prompts).toHaveLength(1));

    env.ledger.add(AGENT, CHANNEL, 6);
    expect(harness.cancels).toHaveLength(1);
    expect(harness.cancels[0]?.inFlight).toBe(true);
    expect(env.notices).toHaveLength(1);

    session.enqueue({ id: 2, text: "more" });
    expect(dropped).toEqual([{ prompt: { id: 2, text: "more" }, why: "credit-blocked" }]);
    expect(harness.prompts).toHaveLength(1);
  });

  it("keeps the ledger and the block across Session replacement", async () => {
    const { env, harness, dropped, open } = await setup(5);
    const first = await open();
    env.sessions = [first];
    env.ledger.add(AGENT, CHANNEL, 3);
    first.close("exorcism");

    const second = await open();
    env.sessions = [second];
    expect(env.ledger.amount(AGENT, CHANNEL)).toBe(3);

    // The earlier 3 credits count toward the cap of the new incarnation.
    env.ledger.add(AGENT, CHANNEL, 2.5);
    expect(env.ledger.isBlocked(CHANNEL)).toBe(true);
    expect(env.ledger.amount(AGENT, CHANNEL)).toBe(5.5);

    // A third incarnation is still refused while the block stands.
    second.close("exorcism");
    const third = await open();
    third.enqueue({ id: 9, text: "hello" });
    expect(dropped).toEqual([{ prompt: { id: 9, text: "hello" }, why: "credit-blocked" }]);
    expect(harness.prompts).toHaveLength(0);

    // Clearing the block lets the new Session take prompts again.
    expect(env.ledger.clearBlocked(CHANNEL)).toBe(true);
    third.enqueue({ id: 10, text: "again" });
    await vi.waitFor(() => expect(harness.prompts.map((p) => p.text)).toEqual(["again"]));
  });
});

describe("!reset-credits handler (Req 10.11, 10.12, 10.16)", () => {
  type ResetEnv = {
    readonly env: LedgerEnv;
    readonly sent: { readonly nick: string; readonly text: string }[];
    readonly reset: ReturnType<typeof createResetCreditsHandler>;
  };

  function setup(modes: Readonly<Record<string, HostMembership>>, opts: { agents?: readonly string[] } = {}): ResetEnv {
    const env = makeLedger({ cap: 1 });
    const sent: { nick: string; text: string }[] = [];
    const reset = createResetCreditsHandler({
      ledger: env.ledger,
      modeOf: (channel, nick) => modes[`${nick}\0${channel}`],
      noticeTo: (nick, text) => {
        sent.push({ nick, text });
        return true;
      },
      isAgentNick: (nick) => (opts.agents ?? []).includes(nick),
      logger: makeLogger().logger,
    });
    return { env, sent, reset };
  }

  const OP: HostMembership = { op: true, voice: false };
  const VOICE: HostMembership = { op: false, voice: true };

  it("matches only the exact command after trimming", () => {
    expect(isResetCreditsCommand("!reset-credits")).toBe(true);
    expect(isResetCreditsCommand("  !reset-credits \t")).toBe(true);
    expect(isResetCreditsCommand("!reset-credits now")).toBe(false);
    expect(isResetCreditsCommand("!RESET-CREDITS")).toBe(false);
    expect(isResetCreditsCommand("please !reset-credits")).toBe(false);
  });

  it("says no channel is blocked and changes nothing", () => {
    const { env, sent, reset } = setup({ [`alice\0#dev`]: OP });
    env.ledger.add(AGENT, CHANNEL, 0.5);
    expect(reset("alice", AGENT)).toEqual({ kind: "no-blocked-channel" });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.nick).toBe("alice");
    expect(sent[0]?.text).toBe("no channel of Ghost is credit-blocked");
  });

  it("clears the block for a +o sender and names the channel", () => {
    const { env, sent, reset } = setup({ [`alice\0#dev`]: OP });
    env.ledger.add(AGENT, CHANNEL, 2);
    expect(env.ledger.isBlocked(CHANNEL)).toBe(true);

    expect(reset("alice", AGENT)).toEqual({ kind: "cleared", cleared: ["#dev"], kept: [] });
    expect(env.ledger.isBlocked(CHANNEL)).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("#dev");
  });

  it.each([
    ["has only +v", VOICE],
    ["is not a member", undefined],
  ])("keeps the block and asks for operator rights when the sender %s", (_name, mode) => {
    const { env, sent, reset } = setup(mode === undefined ? {} : { [`alice\0#dev`]: mode });
    env.ledger.add(AGENT, CHANNEL, 2);

    expect(reset("alice", AGENT)).toEqual({ kind: "not-operator", blocked: ["#dev"] });
    expect(env.ledger.isBlocked(CHANNEL)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("operator rights");
  });

  it("clears only the channels where the sender has +o", () => {
    const { env, sent, reset } = setup({ [`alice\0#dev`]: OP, [`alice\0#ops`]: VOICE });
    env.ledger.add(AGENT, "#dev", 2);
    env.ledger.add(AGENT, "#ops", 2);

    expect(reset("alice", AGENT)).toEqual({ kind: "cleared", cleared: ["#dev"], kept: ["#ops"] });
    expect(env.ledger.isBlocked("#dev")).toBe(false);
    expect(env.ledger.isBlocked("#ops")).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("#dev");
    expect(sent[0]?.text).toContain("#ops");
  });

  it("ignores blocks of other agents' channels", () => {
    const { env, reset } = setup({ [`alice\0#other`]: OP });
    env.ledger.add("Wraith", "#other", 2);
    expect(reset("alice", AGENT)).toEqual({ kind: "no-blocked-channel" });
    expect(env.ledger.isBlocked("#other")).toBe(true);
  });

  it("never lets an Agent clear a block, even with +o", () => {
    const { env, reset } = setup({ [`Imp\0#dev`]: OP }, { agents: ["Imp"] });
    env.ledger.add(AGENT, CHANNEL, 2);
    expect(reset("Imp", AGENT)).toEqual({ kind: "not-operator", blocked: ["#dev"] });
    expect(env.ledger.isBlocked(CHANNEL)).toBe(true);
  });

  it("still returns the outcome and logs when the reply NOTICE throws", () => {
    const env = makeLedger({ cap: 1 });
    const { logger, errors } = makeLogger();
    const reset = createResetCreditsHandler({
      ledger: env.ledger,
      modeOf: () => ({ op: true, voice: false }),
      noticeTo: () => {
        throw new Error("socket closed");
      },
      logger,
    });
    env.ledger.add(AGENT, CHANNEL, 2);
    expect(reset("alice", AGENT).kind).toBe("cleared");
    expect(errors.map((e) => e.msg)).toEqual(["!reset-credits reply failed"]);
  });
});

describe("!reset-credits never reaches the harness (Req 10.14)", () => {
  it("is intercepted in the SessionManager before any prompt or Session", async () => {
    const env = makeLedger({ cap: 1 });
    const harness = new FakeHarness();
    const notices: { readonly nick: string; readonly text: string }[] = [];
    const listeners = new Set<(msg: unknown) => void>();
    const { logger } = makeLogger();
    const timers = new TimerSet(env.clock);

    const host: SessionManagerDeps["host"] = {
      modeOf: (_channel, nick) => (nick === "alice" ? { op: true, voice: false } : undefined),
      channel: () => undefined,
      noticeTo: (nick, text) => {
        notices.push({ nick, text });
        return true;
      },
    };

    const manager = new SessionManager({
      host,
      registry: { lookup: () => undefined },
      harness,
      worktrees: { privateDir: () => Promise.reject(new Error("must not be called")) },
      channelLog: { add: () => undefined },
      ledger: env.ledger,
      clock: env.clock,
      timers,
      logger,
    } as unknown as SessionManagerDeps);

    const off = manager.registerAgent({
      profile: { nick: AGENT, kiroAgent: "ghost", model: "m", tools: "read", color: 3, file: "ghost.json" },
      client: {
        onMessage: (l: (msg: unknown) => void) => {
          listeners.add(l);
          return () => void listeners.delete(l);
        },
      },
      output: {},
    } as unknown as Parameters<SessionManager["registerAgent"]>[0]);

    env.ledger.add(AGENT, CHANNEL, 2);
    expect(env.ledger.isBlocked(CHANNEL)).toBe(true);

    for (const l of listeners) {
      l({ prefix: "alice!u@h", command: "PRIVMSG", params: [AGENT, "  !reset-credits  "] });
    }
    await settle();

    expect(env.ledger.isBlocked(CHANNEL)).toBe(false);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.nick).toBe("alice");
    expect(harness.prompts).toHaveLength(0);
    expect(harness.spawnCount(AGENT)).toBe(0);
    off();
  });
});
