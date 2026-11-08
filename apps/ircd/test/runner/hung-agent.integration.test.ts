import { afterEach, describe, expect, it } from "vitest";
import { ManualClock, closeAllFixtures, startIntegration } from "./integration.js";
import type { FakeAgentScript, IntegrationFixture, IrcTestClient, LogRecord } from "./integration.js";

// Task 22.6: hung agents, crashes and revival (Requirements 9.12 - 9.16).
// The watchdog, the sentence buffer's idle flush and every Cooldown run on the
// injected ManualClock, so the 120 s prompt timeout costs no wall-clock time.

const PROMPT_TIMEOUT_MS = 120_000; // SEANCE_PROMPT_TIMEOUT_MS default
const IDLE_FLUSH_MS = 1_500; // SentenceBuffer DEFAULT_IDLE_FLUSH_MS
const HANG = "HANGME";
const CRASH = "CRASHME";
const CHANNEL = "#seance1";
const OTHER_CHANNEL = "#seance2";

// Each test spawns real Fake_Agent processes (one Node startup per spawn).
const TEST_TIMEOUT_MS = 30_000;

const clocks = new Set<ManualClock>();

afterEach(async () => {
  // Shutdown may wait for a Cooldown on the ManualClock; keep time moving until teardown ends.
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

/** Polls `find` in real time until it returns a value. */
async function until<T>(what: string, find: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = find();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

const logMatching = (f: IntegrationFixture, pred: (r: LogRecord) => boolean): LogRecord | undefined =>
  f.logs.find(pred);

const exits = (f: IntegrationFixture): readonly LogRecord[] => f.logs.filter((r) => r.msg === "acp exit");

const hungLogs = (f: IntegrationFixture): readonly LogRecord[] =>
  f.logs.filter((r) => r.msg === "agent hung, sending SIGTERM");

/** Waits until the runner has received an inbound ACP frame containing `text`. */
const frameReceived = (f: IntegrationFixture, text: string): Promise<LogRecord> =>
  until(`ACP frame containing ${text}`, () =>
    logMatching(f, (r) => r.msg === "acp <<" && typeof r.fields?.["frame"] === "string" && r.fields["frame"].includes(text)),
  );

// A single-word trailing has no `:`, and agent lines start with an IRC color code.
const agentSays = (text: string): RegExp => new RegExp(`^:coder!\\S+ PRIVMSG \\S+ :?(?:\\x03\\d{1,2})?${text}`);
const timeoutNotice = (channel: string): RegExp => new RegExp(`^:coder!\\S+ NOTICE ${channel} :?timeout$`, "i");
const agentLeaves = /^:coder!\S+ (PART|QUIT|KICK)/;

interface Room {
  readonly fixture: IntegrationFixture;
  readonly clock: ManualClock;
  readonly op: IrcTestClient;
}

/** Starts the fixture, invites `coder` into each channel, waits for its Session and gives it `+o`. */
async function openRoom(script: FakeAgentScript, channels: readonly string[] = [CHANNEL]): Promise<Room> {
  const clock = new ManualClock();
  clocks.add(clock);
  const fixture = await startIntegration({ script, clock });
  const op = await fixture.connectClient("alice");
  for (const channel of channels) {
    await op.join(channel);
    op.send(`INVITE coder ${channel}`);
    await op.waitFor(/^:\S+ 341 /);
    await until(`coder session in ${channel}`, () =>
      logMatching(fixture, (r) => r.msg === "agent joined channel" && r.fields?.["channel"] === channel),
    );
    op.send(`MODE ${channel} +o coder`);
    await op.waitFor(new RegExp(`^:alice!\\S+ MODE ${channel} \\+o coder`, "i"));
    await until(`runner saw +o in ${channel}`, () =>
      logMatching(fixture, (r) => r.msg === "channel mode changed" && r.fields?.["channel"] === channel),
    );
  }
  return { fixture, clock, op };
}

/**
 * Sends `text` to `channel` and waits until the agent's first chunk `said` is in
 * the channel. Mid-turn text sits in the SentenceBuffer until its idle flush, so
 * the clock moves by IDLE_FLUSH_MS (well below the prompt timeout).
 */
async function startHangingTurn(room: Room, channel: string, text: string, said: string): Promise<void> {
  room.op.send(`PRIVMSG ${channel} :${text}`);
  await frameReceived(room.fixture, said);
  room.clock.advance(IDLE_FLUSH_MS);
  await room.op.waitFor(agentSays(said.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

const HANGING_TURN = { match: HANG, steps: [{ chunk: "Started." }, { gate: "never" }] } as const;

describe("hung agent watchdog (9.12, 9.13)", { timeout: TEST_TIMEOUT_MS }, () => {
  it("posts NOTICE timeout and SIGTERMs the process once SEANCE_PROMPT_TIMEOUT_MS passes without a frame", async () => {
    const room = await openRoom({ turns: [HANGING_TURN] });
    const { fixture, clock, op } = room;
    await startHangingTurn(room, CHANNEL, HANG, "Started.");

    // The last frame (the chunk) arrived IDLE_FLUSH_MS ago; stop 1 ms short of the timeout.
    clock.advance(PROMPT_TIMEOUT_MS - IDLE_FLUSH_MS - 1);
    expect(await op.expectNone(timeoutNotice(CHANNEL), 200)).toBe(true);
    expect(hungLogs(fixture)).toHaveLength(0);
    expect(exits(fixture)).toHaveLength(0);

    clock.advance(1);
    await op.waitFor(timeoutNotice(CHANNEL));
    const exit = await until("SIGTERM exit", () => exits(fixture)[0]);
    expect(exit.fields?.["signal"]).toBe("SIGTERM");
    expect(hungLogs(fixture)).toHaveLength(1);
    // The Agent is not removed from the channel (9.14).
    expect(await op.expectNone(agentLeaves, 200)).toBe(true);
  });

  it("sends timeout only to channels with a prompting Session", async () => {
    const room = await openRoom(
      { turns: [{ match: "first", steps: [{ chunk: "Alpha." }, { gate: "never" }] }] },
      [CHANNEL, OTHER_CHANNEL],
    );
    const { fixture, clock, op } = room;
    await startHangingTurn(room, CHANNEL, "first", "Alpha.");
    clock.advance(PROMPT_TIMEOUT_MS);
    await op.waitFor(timeoutNotice(CHANNEL));
    await until("SIGTERM exit", () => exits(fixture)[0]);
    // OTHER_CHANNEL's Session was idle: no notice there.
    expect(await op.expectNone(timeoutNotice(OTHER_CHANNEL), 200)).toBe(true);
    expect(op.lines.filter((l) => /NOTICE \S+ :?timeout$/.test(l))).toHaveLength(1);
  });

  it("sends timeout to every channel when Sessions in both are prompting", async () => {
    const room = await openRoom(
      {
        turns: [
          { match: "one", steps: [{ chunk: "First." }, { gate: "never" }] },
          { match: "two", steps: [{ chunk: "Second." }, { gate: "never" }] },
        ],
      },
      [CHANNEL, OTHER_CHANNEL],
    );
    const { fixture, clock, op } = room;
    await startHangingTurn(room, CHANNEL, "one", "First.");
    await startHangingTurn(room, OTHER_CHANNEL, "two", "Second.");
    clock.advance(PROMPT_TIMEOUT_MS);
    for (const channel of [CHANNEL, OTHER_CHANNEL]) {
      await until(`timeout notice in ${channel}`, () => op.lines.find((l) => timeoutNotice(channel).test(l)));
    }
    await until("SIGTERM exit", () => exits(fixture)[0]);
    expect(hungLogs(fixture)).toHaveLength(1);
  });

  it("revives the Agent with a new process and session on the next message after a hang", async () => {
    const room = await openRoom({ turns: [HANGING_TURN] });
    const { fixture, clock, op } = room;
    await startHangingTurn(room, CHANNEL, HANG, "Started.");
    clock.advance(PROMPT_TIMEOUT_MS);
    await op.waitFor(timeoutNotice(CHANNEL));
    await until("SIGTERM exit", () => exits(fixture)[0]);

    op.send(`PRIVMSG ${CHANNEL} :hello`);
    await op.waitFor(agentSays("ok"));
    await until("revival log", () => logMatching(fixture, (r) => r.msg === "session revived after process exit"));
    // The new process numbers its sessions from 1 again; a second spawn happened.
    expect(fixture.logs.filter((r) => r.msg === "acp spawn")).toHaveLength(2);
  });
});

describe("process exit, crash and respawn (9.14, 9.15, 9.16)", { timeout: TEST_TIMEOUT_MS }, () => {
  const crashScript: FakeAgentScript = {
    turns: [{ match: CRASH, steps: [{ chunk: "Last words." }, { crash: 1 }] }],
  };

  async function crash(room: Room): Promise<LogRecord> {
    room.op.send(`PRIVMSG ${CHANNEL} :${CRASH}`);
    return until("crash exit", () => exits(room.fixture)[0]);
  }

  it("closes the Sessions on a crash and leaves the Agent in the channel", async () => {
    const room = await openRoom(crashScript);
    const { fixture, op } = room;
    const exit = await crash(room);
    expect(exit.fields?.["code"]).toBe(1);
    expect(exit.fields?.["signal"]).toBeNull();

    expect(await op.expectNone(agentLeaves, 200)).toBe(true);
    op.send(`NAMES ${CHANNEL}`);
    const names = await op.waitFor(/^:\S+ 353 /);
    expect(names).toMatch(/[ :@+]coder(\s|$)/);
    // A crash is not a hang: no watchdog, no timeout notice.
    expect(hungLogs(fixture)).toHaveLength(0);
    expect(op.lines.some((l) => timeoutNotice(CHANNEL).test(l))).toBe(false);
  });

  it("respawns the process and opens a new session on the next message", async () => {
    const room = await openRoom(crashScript);
    const { fixture, op } = room;
    await crash(room);

    op.send(`PRIVMSG ${CHANNEL} :hello`);
    await op.waitFor(agentSays("ok"));
    await until("revival log", () =>
      logMatching(fixture, (r) => r.msg === "session revived after process exit" && r.fields?.["channel"] === CHANNEL),
    );
    expect(fixture.logs.filter((r) => r.msg === "acp spawn")).toHaveLength(2);
    // The respawned process is alive: still one exit.
    expect(exits(fixture)).toHaveLength(1);
  });

  it("notices 'could not be started' and keeps the Agent when the respawn fails, then recovers", async () => {
    const room = await openRoom(crashScript);
    const { fixture, op } = room;
    await crash(room);

    // The next spawn reads this script and exits during `initialize`.
    const good = process.env["FAKE_AGENT_SCRIPT"];
    process.env["FAKE_AGENT_SCRIPT"] = JSON.stringify({ turns: [], initExitCode: 3 });
    try {
      op.send(`PRIVMSG ${CHANNEL} :hello`);
      const notice = await op.waitFor(/^:coder!\S+ NOTICE \S+ :?.*could not be started/);
      expect(notice).toContain(CHANNEL);
      expect(new TextEncoder().encode(`${notice}\r\n`).length).toBeLessThanOrEqual(512);
      // The prompt was dropped and the Agent stayed.
      expect(await op.expectNone(agentSays("ok"), 200)).toBe(true);
      expect(await op.expectNone(agentLeaves, 100)).toBe(true);
      expect(fixture.logs.some((r) => r.msg === "session revival failed")).toBe(true);
    } finally {
      if (good === undefined) delete process.env["FAKE_AGENT_SCRIPT"];
      else process.env["FAKE_AGENT_SCRIPT"] = good;
    }

    // A later message tries again and succeeds once the process can start.
    op.send(`PRIVMSG ${CHANNEL} :hello again`);
    await op.waitFor(agentSays("ok"));
  });
});
