// Task 17.5: Exorcism (createExorcist + createExorcismTriggers) against the FakeHarness.
// Time is virtual: ManualClock for the runner's timers, harness.advance for the Fake_Agent.
// No wall-clock sleeps.
import type { IrcMessage } from "@seance/irc-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { TimerSet } from "../src/clock.js";
import { createExorcist, type ExorcismTrigger } from "../src/exorcism/exorcism.js";
import { createExorcismTriggers } from "../src/exorcism/triggers.js";
import type { RunnerLogger } from "../src/log.js";
import type { HostEvents, HostMembership, HostVirtualClient } from "../src/ports.js";
import type { AgentProfile } from "../src/registry/agent-profile.js";
import { inviteKey } from "../src/session/session-manager.js";
import { Session } from "../src/session/session.js";
import { WhoisSnapshot } from "../src/whois/snapshot.js";
import type { FakeScript } from "./fixtures/fake-agent.js";
import { FakeHarness } from "./fixtures/fake-harness.js";
import { ManualClock } from "./fixtures/manual-clock.js";

const AGENT = "Ghost";
const DEV = "#dev";
const OPS = "#ops";
const PROFILE: AgentProfile = {
  nick: AGENT,
  kiroAgent: "ghost",
  model: "claude-haiku-5.5",
  tools: "read",
  color: 3,
  file: "ghost.json",
};
const SCRIPT: FakeScript = {
  turns: [{ match: "SLOW", steps: [{ gate: "g1" }, { chunk: "done" }] }, { steps: [{ chunk: "ok" }] }],
};

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of disposers.splice(0)) await fn();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 25; i++) await Promise.resolve();
}

type Sink = { readonly id: number; readonly why: string };

type Env = {
  readonly harness: FakeHarness;
  readonly clock: ManualClock;
  /** Everything observable, in order: "cancel", "reset:<channel>", "close-harness", "PART ...", "away". */
  readonly events: string[];
  readonly resets: string[];
  readonly reports: string[];
  readonly dropped: Sink[];
  readonly parts: IrcMessage[];
  readonly members: Set<string>;
  readonly removed: string[];
  readonly sessions: Map<string, Session>;
  readonly exorcise: (session: Session, trigger: ExorcismTrigger) => Promise<void>;
  readonly states: string[];
  failReset: boolean;
  open(channel: string): Promise<Session>;
  /** Drives virtual time until `p` settles. */
  settle(p: Promise<void>): Promise<void>;
};

async function setup(): Promise<Env> {
  const harness = new FakeHarness({ defaultScript: SCRIPT });
  disposers.push(() => harness.dispose());
  const clock = new ManualClock();
  const timers = new TimerSet(clock);
  const events: string[] = [];
  const resets: string[] = [];
  const reports: string[] = [];
  const dropped: Sink[] = [];
  const parts: IrcMessage[] = [];
  const members = new Set<string>([DEV, OPS]);
  const removed: string[] = [];
  const sessions = new Map<string, Session>();
  const states: string[] = [];
  const logger: RunnerLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  const client: HostVirtualClient = {
    id: "v1",
    nick: AGENT,
    virtual: true,
    send: () => undefined,
    dispatch: (msg) => {
      parts.push(msg);
      events.push(`${msg.command} ${msg.params.join(" ")}`);
      return undefined;
    },
    onMessage: () => () => undefined,
    setAway: () => void events.push("away"),
    close: () => undefined,
  };
  const env: Env = {
    harness,
    clock,
    events,
    resets,
    reports,
    dropped,
    parts,
    members,
    removed,
    sessions,
    states,
    failReset: false,
    exorcise: createExorcist({
      host: {
        modeOf: (channel): HostMembership | undefined =>
          members.has(channel) ? { op: false, voice: false } : undefined,
      },
      sessions: {
        removeChannelSession: (agent, channel) => {
          removed.push(inviteKey(agent, channel));
          sessions.delete(inviteKey(agent, channel));
        },
      },
      worktrees: {
        reset: async (channel: string) => {
          events.push(`reset:${channel}`);
          resets.push(channel);
          states.push(sessions.get(inviteKey(AGENT, channel))?.state ?? "gone");
          if (env.failReset) throw new Error("git reset exploded");
          return undefined as never;
        },
      },
      timers,
      logger,
      clientOf: () => client,
      report: (channel, text) => void reports.push(`${channel}: ${text}`),
      closeHarnessSession: async () => void events.push("close-harness"),
    }),
    async open(channel) {
      const hs = await harness.openSession(PROFILE, {
        cwd: `/tmp/seance-fake-${channel}`,
        onPermission: async () => ({ cancelled: true }),
      });
      const origCancel = hs.cancel.bind(hs);
      const wrapped = { ...hs, cancel: () => { events.push("cancel"); origCancel(); } };
      const session = new Session({
        agent: AGENT,
        channel,
        harnessSession: wrapped,
        snapshot: new WhoisSnapshot(),
        timers,
        gate: { check: async () => ({ ok: true }) },
        sink: { dropped: (p, why) => void dropped.push({ id: p.id, why }) },
        opNotice: () => undefined,
        isBlocked: () => false,
      });
      sessions.set(inviteKey(AGENT, channel), session);
      return session;
    },
    async settle(p) {
      let done = false;
      void p.then(() => {
        done = true;
      });
      for (let i = 0; i < 400 && !done; i++) {
        await flush();
        harness.advance(25);
        clock.advance(25);
      }
      await flush();
      expect(done).toBe(true);
      await p;
    },
  };
  return env;
}

/** Opens a session and leaves it with a gated turn in flight. */
async function prompting(env: Env, channel: string, id = 1): Promise<Session> {
  const s = await env.open(channel);
  s.enqueue({ id, text: "SLOW work" });
  await flush();
  expect(s.state).toBe("prompting");
  return s;
}

describe("exorcise step order", () => {
  it("cancels, then resets, then closes, then parts and clears AWAY", async () => {
    const env = await setup();
    const s = await prompting(env, DEV);
    await env.settle(env.exorcise(s, "kick"));

    expect(env.events).toEqual([
      "cancel",
      `reset:${DEV}`,
      "close-harness",
      `PART ${DEV} *** ${AGENT} has been exorcised`,
      "away",
    ]);
    // The Session was not yet closed when the reset ran (cancel settled first, close after).
    expect(env.states).toEqual(["idle"]);
    expect(s.state).toBe("closed");
    expect(env.harness.cancels).toHaveLength(1);
    expect(env.harness.cancels[0]?.inFlight).toBe(true);
    expect(env.removed).toEqual([inviteKey(AGENT, DEV)]);
  });

  it("waits for the Cooldown before the reset when the Session is already cooling down", async () => {
    const env = await setup();
    const s = await prompting(env, DEV);
    s.cancel();
    await flush();
    expect(s.state).toBe("cooldown");
    const before = env.harness.cancels.length;

    const p = env.exorcise(s, "part");
    await flush();
    expect(env.resets).toEqual([]); // still waiting
    await env.settle(p);

    expect(env.resets).toEqual([DEV]);
    expect(env.harness.cancels).toHaveLength(before); // no second cancel outside a prompt
    expect(s.state).toBe("closed");
  });

  it("skips session/cancel for an idle Session but still resets and closes", async () => {
    const env = await setup();
    const s = await env.open(DEV);
    expect(s.state).toBe("idle");
    await env.settle(env.exorcise(s, "kick"));

    expect(env.harness.cancels).toEqual([]);
    expect(env.events).not.toContain("cancel");
    expect(env.resets).toEqual([DEV]);
    expect(s.state).toBe("closed");
    expect(env.parts).toHaveLength(1);
  });

  it("drops queued prompts instead of draining them", async () => {
    const env = await setup();
    const s = await prompting(env, DEV, 1);
    s.enqueue({ id: 2, text: "queued" });
    await env.settle(env.exorcise(s, "kick"));

    expect(env.dropped).toEqual([{ id: 2, why: "closing" }]);
    expect(env.harness.prompts.map((p) => p.text)).toEqual(["SLOW work"]);
  });
});

describe("exorcise failures and scope", () => {
  it("reports a reset failure naming the channel and cause, still closes and still leaves", async () => {
    const env = await setup();
    env.failReset = true;
    const s = await env.open(DEV);
    await env.settle(env.exorcise(s, "kick"));

    expect(env.reports).toHaveLength(1);
    expect(env.reports[0]).toContain(DEV);
    expect(env.reports[0]).toContain("git reset exploded");
    expect(s.state).toBe("closed");
    expect(env.parts).toHaveLength(1);
    expect(env.parts[0]?.command).toBe("PART");
  });

  it("resets only the exorcised channel and leaves other Sessions alone", async () => {
    const env = await setup();
    const dev = await env.open(DEV);
    const ops = await prompting(env, OPS);
    await env.settle(env.exorcise(dev, "kick"));

    expect(env.resets).toEqual([DEV]);
    expect(env.parts.map((m) => m.params[0])).toEqual([DEV]);
    expect(ops.state).toBe("prompting");
    expect(env.harness.cancels).toEqual([]);
    expect(env.sessions.has(inviteKey(AGENT, OPS))).toBe(true);
    // Only the Invite_Key of the exorcised channel was released; nothing else (log, branch) is touched.
    expect(env.removed).toEqual([inviteKey(AGENT, DEV)]);
  });

  it("does not PART when the Agent already left, but still resets, closes and clears AWAY", async () => {
    const env = await setup();
    env.members.delete(DEV);
    const s = await env.open(DEV);
    await env.settle(env.exorcise(s, "part"));

    expect(env.parts).toEqual([]);
    expect(env.resets).toEqual([DEV]);
    expect(env.events).toContain("away");
    expect(s.state).toBe("closed");
  });

  it("does not send PART for the QUIT trigger but exorcises the Session", async () => {
    const env = await setup();
    const s = await env.open(DEV);
    await env.settle(env.exorcise(s, "quit"));

    expect(env.parts).toEqual([]);
    expect(env.resets).toEqual([DEV]);
    expect(s.state).toBe("closed");
  });
});

describe("exorcise single-flight", () => {
  it("runs once for duplicate triggers: one cancel, one reset, one PART", async () => {
    const env = await setup();
    const s = await prompting(env, DEV);
    const first = env.exorcise(s, "kick");
    const second = env.exorcise(s, "part");
    expect(second).toBe(first);
    await env.settle(first);

    expect(env.harness.cancels).toHaveLength(1);
    expect(env.resets).toEqual([DEV]);
    expect(env.parts).toHaveLength(1);
  });

  it("allows a new exorcism of the same key after the first one finished", async () => {
    const env = await setup();
    const s = await env.open(DEV);
    await env.settle(env.exorcise(s, "kick"));
    const again = await env.open(DEV);
    await env.settle(env.exorcise(again, "kick"));
    expect(env.resets).toEqual([DEV, DEV]);
  });
});

describe("Exorcism triggers", () => {
  function wire(env: Env) {
    const kickListeners: ((e: HostEvents["irc.kick"]) => void)[] = [];
    const clientListeners: ((m: IrcMessage) => void)[] = [];
    const calls: { readonly channel: string; readonly trigger: ExorcismTrigger }[] = [];
    const lookup = {
      channelSession: (agent: string, channel: string) => env.sessions.get(inviteKey(agent, channel)),
      sessionsOfAgent: (agent: string) =>
        [...env.sessions.values()].filter((s) => s.agent.toLowerCase() === agent.toLowerCase()),
    };
    const triggers = createExorcismTriggers({
      host: {
        subscribe: ((name: string, l: (e: never) => void) => {
          if (name === "irc.kick") kickListeners.push(l as (e: HostEvents["irc.kick"]) => void);
          return () => undefined;
        }) as never,
      },
      sessions: lookup,
      exorcise: async (session, trigger) => {
        calls.push({ channel: session.channel, trigger });
        await env.exorcise(session, trigger);
      },
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    const client: HostVirtualClient = {
      id: "v1",
      send: () => undefined,
      dispatch: () => undefined,
      onMessage: (l) => {
        clientListeners.push(l);
        return () => undefined;
      },
      setAway: () => undefined,
      close: () => undefined,
    };
    triggers.watchAgent(AGENT, client);
    return {
      calls,
      kick: (target: string, channel: string) =>
        kickListeners.forEach((l) => l({ channel, by: "op", target, reason: "bye" })),
      emit: (m: IrcMessage) => clientListeners.forEach((l) => l(m)),
    };
  }

  it("a KICK naming the Agent exorcises that channel's Session only", async () => {
    const env = await setup();
    await env.open(DEV);
    await env.open(OPS);
    const w = wire(env);
    w.kick("someone-else", DEV);
    w.kick(AGENT.toUpperCase(), DEV);
    await flush();
    expect(w.calls).toEqual([{ channel: DEV, trigger: "kick" }]);
  });

  it("the Agent's own PART exorcises; another nick's PART is ignored", async () => {
    const env = await setup();
    await env.open(DEV);
    const w = wire(env);
    w.emit({ prefix: "bob!b@host", command: "PART", params: [DEV] });
    expect(w.calls).toEqual([]);
    w.emit({ prefix: `${AGENT}!g@host`, command: "PART", params: [DEV] });
    expect(w.calls).toEqual([{ channel: DEV, trigger: "part" }]);
  });

  it("ERROR is the QUIT signal and exorcises every Session of the Agent", async () => {
    const env = await setup();
    await env.open(DEV);
    await env.open(OPS);
    const w = wire(env);
    w.emit({ command: "ERROR", params: ["Closing link"] });
    expect(w.calls.map((c) => c.channel).sort()).toEqual([DEV, OPS]);
    expect(w.calls.every((c) => c.trigger === "quit")).toBe(true);
  });

  it("a trigger for an already closed Session does nothing", async () => {
    const env = await setup();
    const s = await env.open(DEV);
    s.close("process-exit");
    const w = wire(env);
    w.kick(AGENT, DEV);
    expect(w.calls).toEqual([]);
  });

  it("KICK followed by PART produces exactly one session/cancel end to end", async () => {
    const env = await setup();
    const s = await prompting(env, DEV);
    const w = wire(env);
    w.kick(AGENT, DEV);
    w.emit({ prefix: `${AGENT}!g@host`, command: "PART", params: [DEV] });
    for (let i = 0; i < 400 && s.state !== "closed"; i++) {
      await flush();
      env.harness.advance(25);
      env.clock.advance(25);
    }
    await flush();
    expect(s.state).toBe("closed");
    expect(env.harness.cancels).toHaveLength(1);
    expect(env.resets).toEqual([DEV]);
  });
});
