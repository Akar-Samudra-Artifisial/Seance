// agent-runner Requirement 9, criterion 18: the idle timer of a Session, on a ManualClock.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IrcMessage } from "@seance/irc-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { TimerSet } from "../src/clock.js";
import { CreditLedger } from "../src/credits/ledger.js";
import type { HarnessSession, SessionEvent, TurnResult } from "../src/harness/harness.js";
import { channelPermissionHandler } from "../src/invite/channel-session.js";
import type { LogFields, RunnerLogger } from "../src/log.js";
import { AgentOutput } from "../src/output/agent-output.js";
import type { HostMembership, HostVirtualClient } from "../src/ports.js";
import { ChannelLog } from "../src/prompt/channel-log.js";
import type { AgentProfile } from "../src/registry/agent-profile.js";
import { AgentRegistry } from "../src/registry/agent-registry.js";
import { MemorySessionStore } from "../src/session/memory-session-store.js";
import { PendingPermissions } from "../src/session/pending-permissions.js";
import { SessionManager } from "../src/session/session-manager.js";
import type { AgentRegistration } from "../src/session/session-manager.js";
import { Session } from "../src/session/session.js";
import { WhoisSnapshot } from "../src/whois/snapshot.js";
import { FakeHarness } from "./fixtures/fake-harness.js";
import { ManualClock } from "./fixtures/manual-clock.js";

const IDLE_S = 120;
const IDLE_MS = IDLE_S * 1000;

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function flush(): Promise<void> {
  for (let i = 0; i < 60; i++) await Promise.resolve();
}

type LogEntry = { readonly level: string; readonly msg: string; readonly fields: LogFields };

class FakeHarnessSession implements HarnessSession {
  readonly id = "fake-1";
  readonly #listeners = new Set<(e: SessionEvent) => void>();
  #resolve: ((r: TurnResult) => void) | undefined;
  cancels = 0;

  prompt(): Promise<TurnResult> {
    return new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }
  cancel(): void {
    this.cancels += 1;
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
  onEvent(listener: (e: SessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  emit(e: SessionEvent): void {
    for (const l of [...this.#listeners]) l(e);
  }
  endTurn(): void {
    this.#resolve?.({ stopReason: "end_turn" });
    this.#resolve = undefined;
  }
}

type SetupOptions = {
  readonly blocked?: () => boolean;
  readonly onIdle?: () => void;
};

function setup(options: SetupOptions = {}) {
  const clock = new ManualClock();
  const timers = new TimerSet(clock);
  const harness = new FakeHarnessSession();
  const permissions = new PendingPermissions();
  const log: LogEntry[] = [];
  const logger: RunnerLogger = {
    debug: (msg, fields = {}) => void log.push({ level: "debug", msg, fields }),
    info: (msg, fields = {}) => void log.push({ level: "info", msg, fields }),
    warn: (msg, fields = {}) => void log.push({ level: "warn", msg, fields }),
    error: (msg, fields = {}) => void log.push({ level: "error", msg, fields }),
  };
  const dropped: string[] = [];
  let fired = 0;
  const session = new Session({
    agent: "Ghost",
    channel: "#dev",
    harnessSession: harness,
    snapshot: new WhoisSnapshot(),
    timers,
    gate: { check: () => Promise.resolve({ ok: true }) },
    sink: { dropped: (_p, why) => void dropped.push(why) },
    opNotice: () => undefined,
    isBlocked: options.blocked ?? (() => false),
    logger,
    idle: {
      timeoutS: IDLE_S,
      onIdle: () => {
        fired += 1;
        options.onIdle?.();
      },
      permissions,
    },
  });
  return { clock, timers, harness, permissions, session, log, dropped, fired: () => fired };
}

describe("idle timeout (9.18)", () => {
  it("fires after exactly N seconds idle, once", () => {
    const t = setup();
    t.clock.advance(IDLE_MS - 1);
    expect(t.fired()).toBe(0);
    t.clock.advance(1);
    expect(t.fired()).toBe(1);
    t.clock.advance(10 * IDLE_MS);
    expect(t.fired()).toBe(1);
  });

  // Changed from "a streamed event resets the timer": only an event during a prompt counts now.
  it("a harness event while idle does not restart the timer", () => {
    const t = setup();
    t.clock.advance(IDLE_MS - 10);
    t.harness.emit({ kind: "message-chunk", text: "late" });
    t.harness.emit({ kind: "unknown", sessionUpdate: "late" });
    t.clock.advance(10);
    expect(t.fired()).toBe(1);
  });

  it("events during a prompt keep the timer off, and it restarts when the turn ends", async () => {
    const t = setup();
    t.session.enqueue({ id: 1, text: "work" });
    await flush();
    t.clock.advance(IDLE_MS / 2);
    t.harness.emit({ kind: "message-chunk", text: "working" });
    t.clock.advance(IDLE_MS);
    expect(t.fired()).toBe(0);
    t.harness.endTurn();
    await flush();
    t.clock.advance(IDLE_MS - 1);
    expect(t.fired()).toBe(0);
    t.clock.advance(1);
    expect(t.fired()).toBe(1);
  });

  it("a queued prompt resets the timer, which restarts when the turn ends", async () => {
    const t = setup();
    t.clock.advance(IDLE_MS - 10);
    t.session.enqueue({ id: 1, text: "hello" });
    await flush();
    t.harness.endTurn();
    await flush();
    expect(t.session.state).toBe("idle");
    t.clock.advance(IDLE_MS - 1);
    expect(t.fired()).toBe(0);
    t.clock.advance(1);
    expect(t.fired()).toBe(1);
  });

  it("a prompt dropped because the channel is credit-blocked does not reset the timer", () => {
    let blocked = false;
    const t = setup({ blocked: () => blocked });
    t.clock.advance(IDLE_MS - 10);
    blocked = true;
    t.session.enqueue({ id: 1, text: "ignored" });
    expect(t.dropped).toEqual(["credit-blocked"]);
    t.clock.advance(10);
    expect(t.fired()).toBe(1);
  });

  it("a no-op cancel while idle does not reset the timer", () => {
    const t = setup();
    t.clock.advance(IDLE_MS - 10);
    t.session.cancel();
    t.clock.advance(10);
    expect(t.fired()).toBe(1);
  });

  it("never fires while a prompt is in flight, however long it runs", async () => {
    const t = setup();
    t.session.enqueue({ id: 1, text: "long task" });
    await flush();
    expect(t.session.state).toBe("prompting");
    t.clock.advance(50 * IDLE_MS);
    expect(t.fired()).toBe(0);
    expect(t.harness.cancels).toBe(0);
    t.harness.endTurn();
    await flush();
    t.clock.advance(IDLE_MS);
    expect(t.fired()).toBe(1);
  });

  it("never fires while a permission request is pending, and restarts when it is answered", () => {
    const t = setup();
    t.clock.advance(IDLE_MS - 10);
    const end = t.permissions.begin();
    t.clock.advance(50 * IDLE_MS);
    expect(t.fired()).toBe(0);
    end();
    end(); // idempotent
    t.clock.advance(IDLE_MS - 1);
    expect(t.fired()).toBe(0);
    t.clock.advance(1);
    expect(t.fired()).toBe(1);
  });

  it("a permission handler that throws still ends the pending request, and the timer arms again", async () => {
    const t = setup();
    const throwing: RunnerLogger = {
      debug() {},
      info() {},
      warn() {
        throw new Error("log sink down");
      },
      error() {
        throw new Error("log sink down");
      },
    };
    const profile: AgentProfile = { nick: "Ghost", kiroAgent: "ghost", model: "m", tools: "read", color: 3, file: "g.json" };
    const handler = channelPermissionHandler(
      { host: { modeOf: (): HostMembership | undefined => undefined }, logger: throwing },
      profile,
      "#dev",
      "/tmp/seance-idle-wt",
      { channelNotice: () => undefined },
      t.permissions,
    );
    t.clock.advance(IDLE_MS - 10);
    // A request without options is malformed: the handler logs a warning, the sink throws, and the
    // handler's own catch then fails to log too, so the promise rejects.
    await expect(handler({ tool: { kind: "read", title: "t", paths: [] }, options: [] })).rejects.toThrow("log sink down");
    expect(t.permissions.count).toBe(0);
    t.clock.advance(IDLE_MS - 1);
    expect(t.fired()).toBe(0);
    t.clock.advance(1);
    expect(t.fired()).toBe(1);
  });

  it("an onIdle that throws is logged and leaves no timer armed", () => {
    const t = setup({
      onIdle: () => {
        throw new Error("exorcism wiring broke");
      },
    });
    t.clock.advance(IDLE_MS);
    expect(t.fired()).toBe(1);
    expect(t.log.filter((e) => e.level === "error" && e.msg === "idle handler failed")).toHaveLength(1);
    expect(t.timers.size).toBe(0);
    t.clock.advance(10 * IDLE_MS);
    expect(t.fired()).toBe(1);
  });

  it("is cleared by begin-closing (kick) so it never fires", () => {
    const t = setup();
    t.clock.advance(IDLE_MS - 1);
    t.session.beginClosing();
    expect(t.timers.size).toBe(0);
    t.clock.advance(10 * IDLE_MS);
    expect(t.fired()).toBe(0);
  });

  it("is cleared by close", () => {
    const t = setup();
    t.session.close("exorcism");
    expect(t.timers.size).toBe(0);
    t.clock.advance(10 * IDLE_MS);
    expect(t.fired()).toBe(0);
  });

  it("is cleared by shutdown (TimerSet.clearAll)", () => {
    const t = setup();
    expect(t.timers.size).toBe(1);
    t.timers.clearAll();
    t.clock.advance(10 * IDLE_MS);
    expect(t.fired()).toBe(0);
    expect(t.clock.pending).toBe(0);
  });

  it("a Session without idle settings sets no timer", () => {
    const clock = new ManualClock();
    const timers = new TimerSet(clock);
    new Session({
      agent: "Ghost",
      channel: "#dev",
      harnessSession: new FakeHarnessSession(),
      snapshot: new WhoisSnapshot(),
      timers,
      gate: { check: () => Promise.resolve({ ok: true }) },
      sink: { dropped: () => undefined },
      opNotice: () => undefined,
      isBlocked: () => false,
    });
    expect(timers.size).toBe(0);
  });
});

// ---- Private_Session (/query) ------------------------------------------------------------------

class FakeClient implements HostVirtualClient {
  readonly id = "client-Ghost";
  readonly nick = "Ghost";
  readonly virtual = true;
  #listener: ((msg: IrcMessage) => void) | undefined;
  send(): void {}
  dispatch(): unknown {
    return undefined;
  }
  onMessage(listener: (msg: IrcMessage) => void): () => void {
    this.#listener = listener;
    return () => {
      this.#listener = undefined;
    };
  }
  setAway(): void {}
  close(): void {}
  receive(msg: IrcMessage): void {
    this.#listener?.(msg);
  }
}

async function privateSetup(idleTimeoutS: number | undefined) {
  const dir = await mkdtemp(join(tmpdir(), "seance-idle-private-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "ghost.json"), JSON.stringify({ nick: "Ghost", kiroAgent: "ghost", model: "m", tools: "read", color: 3 }));
  const quiet: RunnerLogger = { debug() {}, info() {}, warn() {}, error() {} };
  const registry = await AgentRegistry.load(dir, quiet);
  const profile = registry.lookup("Ghost");
  if (profile === undefined) throw new Error("profile Ghost missing");
  const harness = new FakeHarness({ defaultScript: { turns: [] } });
  cleanups.push(async () => {
    harness.advance(60_000);
    await flush();
    await harness.dispose();
  });
  const clock = new ManualClock();
  const timers = new TimerSet(clock);
  const notices: { readonly nick: string; readonly text: string }[] = [];
  const client = new FakeClient();
  const manager = new SessionManager({
    host: {
      modeOf: () => undefined,
      channel: () => undefined,
      noticeTo: (nick, text) => {
        notices.push({ nick, text });
        return true;
      },
    },
    registry,
    harness,
    worktrees: { privateDir: () => Promise.resolve("/tmp/seance-idle-private") },
    channelLog: new ChannelLog(),
    ledger: new CreditLedger({
      store: new MemorySessionStore(),
      snapshot: new WhoisSnapshot(),
      clock,
      sessionsOf: () => [],
      opNotice: () => undefined,
    }),
    clock,
    timers,
    logger: quiet,
    ...(idleTimeoutS !== undefined ? { idleTimeoutS } : {}),
  });
  const reg: AgentRegistration = {
    profile,
    client,
    output: new AgentOutput({ client, logger: quiet, nick: "Ghost", user: "Ghost", host: "seance", color: 3 }),
  };
  manager.registerAgent(reg);
  const say = async (text: string): Promise<void> => {
    client.receive({ prefix: "alice!u@h", command: "PRIVMSG", params: ["Ghost", text] });
    await flush();
    harness.advance(60_000); // the scripted turn ends in virtual time
    await flush();
  };
  const privateSessions = (): readonly Session[] => manager.allSessions().filter((s) => s.channel === "alice");
  return { clock, timers, manager, harness, notices, say, privateSessions };
}

describe("idle timeout of a private session (9.18)", () => {
  it("closes the session and notices the human once; the next message starts a fresh one", async () => {
    const t = await privateSetup(IDLE_S);
    await t.say("hello");
    const first = t.privateSessions()[0];
    expect(first?.state).toBe("idle");
    expect(t.manager.privateCount()).toBe(1);

    t.clock.advance(IDLE_MS - 1);
    expect(t.notices).toEqual([]);
    expect(first?.state).toBe("idle");
    t.clock.advance(1);
    await flush();

    expect(t.notices).toEqual([{ nick: "alice", text: "Ghost idle for 2 min, releasing the session" }]);
    expect(first?.state).toBe("closed");
    expect(t.manager.privateCount()).toBe(0);
    expect(t.timers.size).toBe(0);

    await t.say("again");
    const second = t.privateSessions()[0];
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(second?.state).toBe("idle");
    expect(t.harness.prompts.filter((p) => p.agent === "Ghost")).toHaveLength(2);
  });

  it("has no idle timeout without the setting", async () => {
    const t = await privateSetup(undefined);
    await t.say("hello");
    t.clock.advance(100 * IDLE_MS);
    await flush();
    expect(t.notices).toEqual([]);
    expect(t.privateSessions()[0]?.state).toBe("idle");
  });
});
