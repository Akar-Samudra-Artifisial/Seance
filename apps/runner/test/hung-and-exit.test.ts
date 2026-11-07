// Task 17.6: hung agents (Req 9.12, 9.13) and process exit / revival (Req 9.14-9.16).
// Real SessionManager, Session, hung handler and AgentOutput on top of FakeHarness. Time is virtual
// (the AcpHarness watchdog timer itself is covered in harness.test.ts); promises are drained with `flush`.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IrcMessage } from "@seance/irc-protocol";
import { irc_lower } from "@seance/irc-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { TimerSet } from "../src/clock.js";
import { CreditLedger } from "../src/credits/ledger.js";
import type { ProcessEvent } from "../src/harness/harness.js";
import type { RunnerLogger } from "../src/log.js";
import { AgentOutput } from "../src/output/agent-output.js";
import type { HostMembership, HostVirtualClient } from "../src/ports.js";
import { ChannelLog } from "../src/prompt/channel-log.js";
import { AgentRegistry } from "../src/registry/agent-registry.js";
import { handleHung, HUNG_NOTICE_TEXT, installHungHandler } from "../src/session/hung-handler.js";
import type { HungNoticeOutput, HungSessionView } from "../src/session/hung-handler.js";
import { MemorySessionStore } from "../src/session/memory-session-store.js";
import { SessionManager } from "../src/session/session-manager.js";
import type { AgentRegistration } from "../src/session/session-manager.js";
import { Session } from "../src/session/session.js";
import type { SinkDropReason } from "../src/session/session.js";
import type { Prompt } from "../src/session/machine.js";
import { WhoisSnapshot } from "../src/whois/snapshot.js";
import type { FakeScript } from "./fixtures/fake-agent.js";
import { FakeHarness } from "./fixtures/fake-harness.js";
import { ManualClock } from "./fixtures/manual-clock.js";

const DEV = "#dev";
const OPS = "#ops";
const GHOST = "Ghost";
const WRAITH = "Wraith";

const SCRIPT: FakeScript = {
  turns: [
    { match: "SLOW", steps: [{ gate: "g1" }, { chunk: "done" }] },
    { steps: [{ chunk: "ok" }] },
  ],
};

const quiet: RunnerLogger = { debug() {}, info() {}, warn() {}, error() {} };

// ---- pure hung handler ---------------------------------------------------------------------

type HungEvent = Extract<ProcessEvent, { readonly kind: "hung" }>;
const hungEvent = (agent: string): HungEvent => ({ kind: "hung", agent, sessionIds: [] });

describe("handleHung", () => {
  const view = (channel: string, state: HungSessionView["state"]): HungSessionView => ({ channel, state });

  it("posts NOTICE `timeout` only to channels with a prompting Session", () => {
    const sent: [string, string][] = [];
    const output: HungNoticeOutput = { channelNotice: (c, t) => void sent.push([c, t]) };
    const notified = handleHung(hungEvent(GHOST), {
      sessionsOfAgent: () => [view(DEV, "prompting"), view(OPS, "idle"), view("#cold", "cooldown")],
      outputOf: () => output,
    });
    expect(notified).toEqual([DEV]);
    expect(sent).toEqual([[DEV, HUNG_NOTICE_TEXT]]);
    expect(HUNG_NOTICE_TEXT).toBe("timeout");
  });

  it("does nothing for an unknown agent", () => {
    expect(
      handleHung(hungEvent("Nobody"), {
        sessionsOfAgent: () => [view(DEV, "prompting")],
        outputOf: () => undefined,
      }),
    ).toEqual([]);
  });

  it("keeps serving the other channels when one notice fails", () => {
    const sent: string[] = [];
    const errors: string[] = [];
    const output: HungNoticeOutput = {
      channelNotice: (c) => {
        if (c === DEV) throw new Error("boom");
        sent.push(c);
      },
    };
    const notified = handleHung(hungEvent(GHOST), {
      sessionsOfAgent: () => [view(DEV, "prompting"), view(OPS, "prompting")],
      outputOf: () => output,
      onError: (c) => void errors.push(c),
    });
    expect(notified).toEqual([OPS]);
    expect(sent).toEqual([OPS]);
    expect(errors).toEqual([DEV]);
  });

  it("installHungHandler reacts to `hung` only and can be unsubscribed", () => {
    let listener: ((e: ProcessEvent) => void) | undefined;
    const harness = {
      onProcessEvent: (l: (e: ProcessEvent) => void) => {
        listener = l;
        return () => {
          listener = undefined;
        };
      },
    };
    const sent: string[] = [];
    const off = installHungHandler(harness, {
      sessionsOfAgent: () => [view(DEV, "prompting")],
      outputOf: () => ({ channelNotice: (c) => void sent.push(c) }),
    });
    listener?.({ kind: "exited", agent: GHOST, code: 1, signal: null });
    expect(sent).toEqual([]);
    listener?.(hungEvent(GHOST));
    expect(sent).toEqual([DEV]);
    off();
    expect(listener).toBeUndefined();
  });
});

// ---- rig -----------------------------------------------------------------------------------

class RecordingClient implements HostVirtualClient {
  readonly id: string;
  readonly nick: string;
  readonly virtual = true;
  readonly sent: IrcMessage[] = [];
  constructor(nick: string) {
    this.id = `client-${nick}`;
    this.nick = nick;
  }
  send(): void {}
  dispatch(msg: IrcMessage): unknown {
    this.sent.push(msg);
    return undefined;
  }
  onMessage(): () => void {
    return () => undefined;
  }
  setAway(): void {}
  close(): void {}
  /** `[channel, text]` of every NOTICE sent. */
  notices(): [string, string][] {
    return this.sent
      .filter((m) => m.command === "NOTICE")
      .map((m) => [m.params[0] ?? "", m.params[1] ?? ""]);
  }
}

type Dropped = { readonly agent: string; readonly prompt: Prompt; readonly why: SinkDropReason };

type Rig = {
  readonly harness: FakeHarness;
  readonly manager: SessionManager;
  readonly clients: Record<string, RecordingClient>;
  readonly dropped: Dropped[];
  readonly revived: string[];
  readonly rejections: Error[];
  readonly events: ProcessEvent[];
  failRevival: boolean;
  say(from: string, text: string, channel?: string): void;
  /** Removes the agent's membership in the fake host. */
  leave(agent: string, channel: string): void;
  session(agent: string, channel: string): Session;
  promptsOf(agent: string): string[];
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

async function makeRegistry(): Promise<AgentRegistry> {
  const dir = await mkdtemp(join(tmpdir(), "seance-hung-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  for (const [i, nick] of [GHOST, WRAITH].entries()) {
    const profile = { nick, kiroAgent: nick.toLowerCase(), model: "m", tools: "read", color: i + 1 };
    await writeFile(join(dir, `${nick.toLowerCase()}.json`), JSON.stringify(profile));
  }
  return AgentRegistry.load(dir, quiet);
}

async function setup(channelsOf: Readonly<Record<string, readonly string[]>>): Promise<Rig> {
  const registry = await makeRegistry();
  const harness = new FakeHarness({ defaultScript: SCRIPT });
  cleanups.push(() => harness.dispose());
  const clock = new ManualClock();
  const timers = new TimerSet(clock);
  const snapshot = new WhoisSnapshot();
  const modes = new Map<string, HostMembership>();
  const modeKey = (c: string, n: string): string => `${irc_lower(c)}\0${irc_lower(n)}`;
  const dropped: Dropped[] = [];
  const revived: string[] = [];
  const rejections: Error[] = [];
  const events: ProcessEvent[] = [];
  harness.onProcessEvent((e) => void events.push(e));

  const manager = new SessionManager({
    host: {
      modeOf: (c, n) => modes.get(modeKey(c, n)),
      channel: () => undefined,
      noticeTo: () => true,
    },
    registry,
    harness,
    worktrees: { privateDir: async () => "/tmp/seance-fake-private" },
    channelLog: new ChannelLog(),
    ledger: new CreditLedger({
      store: new MemorySessionStore(),
      snapshot,
      clock,
      cap: 1,
      sessionsOf: () => [],
      opNotice: () => undefined,
    }),
    clock,
    timers,
    logger: quiet,
    reviveSession: async (reg, channel) => {
      revived.push(`${reg.profile.nick}${channel}`);
      if (rig.failRevival) throw new Error("spawn failed");
      return openSession(reg, channel);
    },
  });

  const clients: Record<string, RecordingClient> = {};
  const regs = new Map<string, AgentRegistration>();
  const openSession = async (reg: AgentRegistration, channel: string): Promise<Session> => {
    const hs = await harness.openSession(reg.profile, {
      cwd: "/tmp/seance-fake-worktree",
      onPermission: async () => ({ cancelled: true }),
    });
    return new Session({
      agent: reg.profile.nick,
      channel,
      harnessSession: {
        ...hs,
        prompt: (text) =>
          hs.prompt(text).catch((e: unknown) => {
            const err = e instanceof Error ? e : new Error(String(e));
            rejections.push(err);
            throw err;
          }),
      },
      snapshot,
      timers,
      gate: { check: async () => ({ ok: true }) },
      sink: { dropped: (prompt, why) => void dropped.push({ agent: reg.profile.nick, prompt, why }) },
      opNotice: () => undefined,
      isBlocked: () => false,
    });
  };

  for (const [nick, channels] of Object.entries(channelsOf)) {
    const profile = registry.lookup(nick);
    if (profile === undefined) throw new Error(`profile ${nick} missing`);
    const client = new RecordingClient(nick);
    clients[nick] = client;
    const reg: AgentRegistration = {
      profile,
      client,
      output: new AgentOutput({ client, logger: quiet, nick, user: nick, host: "seance", color: profile.color }),
    };
    regs.set(irc_lower(nick), reg);
    manager.registerAgent(reg);
    for (const channel of channels) {
      modes.set(modeKey(channel, nick), { op: true, voice: false });
      manager.addChannelSession(await openSession(reg, channel));
    }
  }
  for (const channel of [DEV, OPS]) modes.set(modeKey(channel, "bob"), { op: true, voice: false });

  installHungHandler(harness, {
    sessionsOfAgent: (agent) => manager.sessionsOfAgent(agent),
    outputOf: (agent) => regs.get(irc_lower(agent))?.output,
  });
  manager.attach();

  const rig: Rig = {
    harness,
    manager,
    clients,
    dropped,
    revived,
    rejections,
    events,
    failRevival: false,
    say: (from, text, channel = DEV) =>
      manager.onChannelMessage({
        channel,
        from,
        message: { prefix: `${from}!u@h`, command: "PRIVMSG", params: [channel, text] },
      }),
    leave: (agent, channel) => void modes.delete(modeKey(channel, agent)),
    session: (agent, channel) => {
      const s = manager.channelSession(agent, channel);
      if (s === undefined) throw new Error(`no Session for ${agent} in ${channel}`);
      return s;
    },
    promptsOf: (agent) => harness.prompts.filter((p) => p.agent === agent).map((p) => p.text),
  };
  return rig;
}

// ---- hung agents ---------------------------------------------------------------------------

describe("hung agent", () => {
  it("posts `timeout` to prompting channels only, rejects the prompt and ends the process with SIGTERM", async () => {
    const rig = await setup({ [GHOST]: [DEV, OPS], [WRAITH]: [DEV] });
    rig.say("bob", "SLOW work"); // Ghost and Wraith both start a turn in #dev; Ghost's #ops stays idle
    await flush();
    expect(rig.session(GHOST, DEV).state).toBe("prompting");
    expect(rig.session(GHOST, OPS).state).toBe("idle");

    rig.harness.simulateHung(GHOST);
    await flush();

    expect(rig.clients[GHOST]?.notices()).toEqual([[DEV, "timeout"]]);
    expect(rig.clients[WRAITH]?.notices()).toEqual([]);
    expect(rig.events.map((e) => e.kind)).toEqual(["hung", "exited"]);
    expect(rig.events[0]).toMatchObject({ kind: "hung", agent: GHOST });
    expect(rig.events[1]).toMatchObject({ kind: "exited", agent: GHOST, signal: "SIGTERM" });
    expect(rig.rejections).toHaveLength(1);
    expect(rig.rejections[0]?.message).toMatch(/exited/);
    // The exit path closed the hung process's Sessions and left the other agent alone.
    expect(rig.session(GHOST, DEV).state).toBe("closed");
    expect(rig.session(GHOST, OPS).state).toBe("closed");
    expect(rig.session(WRAITH, DEV).state).toBe("prompting");
  });

  it("sends no notice when no Session is prompting", async () => {
    const rig = await setup({ [GHOST]: [DEV] });
    rig.harness.simulateHung(GHOST);
    await flush();
    expect(rig.clients[GHOST]?.notices()).toEqual([]);
    expect(rig.session(GHOST, DEV).state).toBe("closed");
  });
});

// ---- process exit and revival --------------------------------------------------------------

describe("process exit", () => {
  it("closes every Session of the process, drops queued prompts and keeps the Agent in its channels", async () => {
    const rig = await setup({ [GHOST]: [DEV, OPS], [WRAITH]: [DEV] });
    rig.say("bob", "SLOW first");
    rig.say("bob", "second");
    rig.say("bob", "third");
    await flush();
    expect(rig.promptsOf(GHOST)).toHaveLength(1);

    rig.harness.simulateExit(GHOST, 1);
    await flush();

    expect(rig.session(GHOST, DEV).state).toBe("closed");
    expect(rig.session(GHOST, OPS).state).toBe("closed");
    expect(rig.session(WRAITH, DEV).state).toBe("prompting");
    expect(
      rig.dropped.filter((d) => d.agent === GHOST).map((d) => [d.prompt.text, d.why]),
    ).toEqual([
      ["[#dev] <@bob> second", "closed"],
      ["[#dev] <@bob> third", "closed"],
    ]);
    // Nothing was sent after the exit, and the Agent was not parted (modes survive in the host).
    expect(rig.promptsOf(GHOST)).toHaveLength(1);
    expect(rig.clients[GHOST]?.sent.filter((m) => m.command === "PART")).toEqual([]);
    expect(rig.revived).toEqual([]); // revival waits for the next prompt
  });

  it("respawns on the next prompt and routes it to a new Session", async () => {
    const rig = await setup({ [GHOST]: [DEV] });
    const old = rig.session(GHOST, DEV);
    rig.harness.simulateExit(GHOST, 1);
    await flush();
    expect(old.state).toBe("closed");
    expect(rig.harness.spawnCount(GHOST)).toBe(1);

    rig.say("bob", "one");
    rig.say("bob", "two"); // arrives while the first revival is in flight: single-flight
    await flush();

    expect(rig.revived).toEqual([`${GHOST}${DEV}`]);
    expect(rig.harness.spawnCount(GHOST)).toBe(2);
    const fresh = rig.session(GHOST, DEV);
    expect(fresh).not.toBe(old);
    expect(rig.promptsOf(GHOST)).toEqual(["[#dev] <@bob> one", "[#dev] <@bob> two"]);
    expect(rig.harness.prompts.every((p) => p.sessionId === fresh.acpSessionId)).toBe(true);
    expect(rig.clients[GHOST]?.notices()).toEqual([]);
  });

  it("tells the channel the Agent could not be started, drops the prompt and keeps the Agent", async () => {
    const rig = await setup({ [GHOST]: [DEV] });
    const old = rig.session(GHOST, DEV);
    rig.harness.simulateExit(GHOST, 1);
    await flush();
    rig.failRevival = true;

    rig.say("bob", "wake up");
    await flush();

    expect(rig.clients[GHOST]?.notices()).toEqual([[DEV, "Ghost: could not be started"]]);
    expect(rig.promptsOf(GHOST)).toEqual([]);
    expect(rig.session(GHOST, DEV)).toBe(old);
    expect(old.state).toBe("closed");
    expect(rig.clients[GHOST]?.sent.filter((m) => m.command === "PART")).toEqual([]);

    // A later attempt can still succeed.
    rig.failRevival = false;
    rig.say("bob", "again");
    await flush();
    expect(rig.promptsOf(GHOST)).toEqual(["[#dev] <@bob> again"]);
    expect(rig.session(GHOST, DEV).state).not.toBe("closed");
  });

  it("does not revive for an Agent that has left the channel", async () => {
    const rig = await setup({ [GHOST]: [DEV] });
    rig.harness.simulateExit(GHOST, 1);
    await flush();
    rig.leave(GHOST, DEV);

    rig.say("bob", "anyone?");
    await flush();

    expect(rig.revived).toEqual([]);
    expect(rig.harness.spawnCount(GHOST)).toBe(1);
    expect(rig.promptsOf(GHOST)).toEqual([]);
    expect(rig.clients[GHOST]?.notices()).toEqual([]);
  });
});
