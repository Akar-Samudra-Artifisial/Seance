import { afterEach, describe, expect, it } from "vitest";
import { ManualClock, closeAllFixtures, startIntegration } from "./integration.js";
import type { FakeAgentScript, IntegrationFixture, IntegrationOptions, IrcTestClient, LogRecord } from "./integration.js";

// Task 22.7: credits metering, WHOIS, the channel credit cap and `!reset-credits`
// (Requirements 10.1, 10.4, 10.9, 10.10, 10.11, 10.12, 10.16) against a real
// Fake_Agent process and an in-process ircd. Every Cooldown and the ledger flush
// run on the injected ManualClock, so no wall-clock sleep is used beyond the
// `expectNone` quiet window that the fixture already bounds.

const CHANNEL = "#seance1";
const OTHER_CHANNEL = "#seance2";
/** `coder.json` uses color 12, written as `\x03` + two digits, closed with `\x0F`. */
const COLOR_OPEN = "\x0312";
const COLOR_RESET = "\x0F";

// Each test spawns one real Fake_Agent process (a Node startup per spawn).
const TEST_TIMEOUT_MS = 30_000;
const UNTIL_TIMEOUT_MS = 10_000;

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
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Polls `find` in real time (yielding to the event loop) until it returns a value. */
async function until<T>(what: string, find: () => T | undefined, timeoutMs = UNTIL_TIMEOUT_MS): Promise<T> {
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

/** Outgoing ACP frames carrying `method` (e.g. `session/cancel`, `session/prompt`). */
const outFrames = (f: IntegrationFixture, method: string): readonly LogRecord[] =>
  f.logs.filter(
    (r) =>
      r.msg.startsWith("acp >> ") &&
      typeof r.fields?.["frame"] === "string" &&
      r.fields["frame"].includes(`"${method}"`),
  );

/** Prompts the runner reported dropped for `channel` (one per refused prompt). */
const dropped = (f: IntegrationFixture, channel: string, why: string): readonly LogRecord[] =>
  f.logs.filter(
    (r) =>
      r.msg === "prompt dropped" && r.fields?.["channel"] === channel && r.fields?.["why"] === why,
  );

/** An agent PRIVMSG carrying exactly `text` (colored). */
const agentSays = (text: string): RegExp =>
  new RegExp(`^:coder![^ ]+ PRIVMSG \\S+ :?${escapeRegExp(COLOR_OPEN)}${escapeRegExp(text)}${escapeRegExp(COLOR_RESET)}$`);

/** Waits until the runner has received an inbound ACP frame containing `text`. */
const frameReceived = (f: IntegrationFixture, text: string): Promise<LogRecord> =>
  until(`ACP frame containing ${text}`, () =>
    logMatching(f, (r) => r.msg === "acp <<" && typeof r.fields?.["frame"] === "string" && r.fields["frame"].includes(text)),
  );

interface Room {
  readonly fixture: IntegrationFixture;
  readonly clock: ManualClock;
  readonly op: IrcTestClient;
}

/** Starts the fixture, invites `coder` into each channel, waits for its Session and gives it `+o`. */
async function openRoom(
  script: FakeAgentScript,
  channels: readonly string[] = [CHANNEL],
  options: Omit<IntegrationOptions, "script" | "clock"> = {},
): Promise<Room> {
  const clock = new ManualClock();
  clocks.add(clock);
  const fixture = await startIntegration({ script, clock, ...options });
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

/** Collects the `320` WHOIS-special lines (the runner's `whoisExtra`) for `nick`. */
async function whoisLines(op: IrcTestClient, nick: string): Promise<readonly string[]> {
  op.send(`WHOIS ${nick}`);
  await op.waitFor(new RegExp(`^:\\S+ 318 \\S+ ${escapeRegExp(nick)} `));
  const prefix = new RegExp(`^:\\S+ 320 \\S+ ${escapeRegExp(nick)} :?(.*)$`);
  const out: string[] = [];
  for (const line of op.lines) {
    const m = prefix.exec(line);
    if (m?.[1] !== undefined) out.push(m[1]);
  }
  return out;
}

describe("credits metering and WHOIS (Req 10.1, 10.4)", { timeout: TEST_TIMEOUT_MS }, () => {
  it("accumulates scripted meteringUsage and shows model, tools, status and credits in WHOIS", async () => {
    // Two turns, each ending after emitting a `credit` metadata entry: the ledger
    // sums 1.25 + 0.5 = 1.75 for the channel (and the agent total).
    const room = await openRoom({
      turns: [
        { match: "first", steps: [{ chunk: "one" }, { metadata: { credits: [{ value: 1.25, unit: "credit" }] } }] },
        { match: "second", steps: [{ chunk: "two" }, { metadata: { credits: [{ value: 0.5, unit: "credit" }] } }] },
      ],
    });
    const { fixture, op } = room;

    op.send(`PRIVMSG ${CHANNEL} :first`);
    await op.waitFor(agentSays("one"));
    await until("first metering recorded", () =>
      fixture.logs.find((r) => r.msg === "acp <<" && typeof r.fields?.["frame"] === "string" && r.fields["frame"].includes("meteringUsage")),
    );

    op.send(`PRIVMSG ${CHANNEL} :second`);
    await op.waitFor(agentSays("two"));
    // The second metadata is the one with value 0.5; wait until both have arrived.
    await until("both meterings recorded", () => {
      const seen = fixture.logs.filter(
        (r) => r.msg === "acp <<" && typeof r.fields?.["frame"] === "string" && r.fields["frame"].includes("meteringUsage"),
      );
      return seen.length >= 2 ? seen : undefined;
    });

    const lines = await whoisLines(op, "coder");
    expect(lines).toContain("model: sonnet-5.5");
    // web-client-extras Req 6: this runner runs with sandbox mode "none", so the shell is the host's.
    // The profile text still says shell(sandbox); the label follows the configured mode.
    expect(lines).toContain("tools: fs, git, shell(host)");
    // agent-skills Req 3.1: agents/coder.json lists one skill; its line follows the tools line.
    expect(lines).toContain("skills: seance-fix-and-commit");
    expect(lines.indexOf("skills: seance-fix-and-commit")).toBe(lines.indexOf("tools: fs, git, shell(host)") + 1);
    expect(lines.some((l) => /^status: (idle|cooldown)$/.test(l))).toBe(true);
    // Exactly two decimals, channel amount and agent total both 1.75.
    expect(lines).toContain(`credits: ${CHANNEL} 1.75 / total 1.75`);
  });

  it("rejects non-credit and negative entries but keeps the valid ones in the sum", async () => {
    // Only the two `credit` entries (2.00 + 0.50) count; the other three are dropped.
    const room = await openRoom({
      turns: [
        {
          match: "go",
          steps: [
            { chunk: "working" },
            {
              metadata: {
                credits: [
                  { value: 2, unit: "credit" },
                  { value: 10, unit: "token" },
                  { value: -3, unit: "credit" },
                  { value: 0.5, unit: "credit" },
                ],
              },
            },
          ],
        },
      ],
    });
    const { fixture, op } = room;
    op.send(`PRIVMSG ${CHANNEL} :go`);
    await op.waitFor(agentSays("working"));
    await until("metering recorded", () =>
      fixture.logs.find((r) => r.msg === "acp <<" && typeof r.fields?.["frame"] === "string" && r.fields["frame"].includes("meteringUsage")),
    );
    await until("two rejections logged", () =>
      fixture.logs.filter((r) => r.msg === "metering entry rejected").length >= 2 ? true : undefined,
    );

    const lines = await whoisLines(op, "coder");
    expect(lines).toContain(`credits: ${CHANNEL} 2.50 / total 2.50`);
  });
});

describe("channel credit cap (Req 10.9, 10.10)", { timeout: TEST_TIMEOUT_MS }, () => {
  const CAP = "1.00";

  it("cancels the in-flight prompt, notices each op and drops later prompts once the cap is exceeded", async () => {
    // The turn streams a chunk, reports credits above the cap while still in
    // flight (a gate keeps it prompting), so the cap check must cancel it.
    const room = await openRoom(
      {
        turns: [
          { match: "spend", steps: [{ chunk: "spending" }, { metadata: { credits: [{ value: 5, unit: "credit" }] } }, { gate: "hold" }] },
        ],
      },
      [CHANNEL],
      { env: { SEANCE_CHANNEL_CREDIT_CAP: CAP } },
    );
    const { fixture, op } = room;

    op.send(`PRIVMSG ${CHANNEL} :spend`);
    // The chunk reaches the runner before the metadata; the cap trips off the metadata,
    // not the (still-buffered) chunk, so wait for the inbound metering frame.
    await frameReceived(fixture, "meteringUsage");

    // Each Human_Op receives one server-prefixed NOTICE naming the channel, the total and the cap.
    const notice = await op.waitFor(
      new RegExp(`^:\\S+ NOTICE alice :?credit cap reached for ${escapeRegExp(CHANNEL)}: 5\\.00 / 1\\.00$`),
    );
    expect(new TextEncoder().encode(`${notice}\r\n`).length).toBeLessThanOrEqual(512);
    expect(
      op.lines.filter((l) => new RegExp(`NOTICE alice :?credit cap reached for ${escapeRegExp(CHANNEL)}`).test(l)),
    ).toHaveLength(1);

    // The in-flight prompt was cancelled: exactly one session/cancel went to the agent.
    await until("session/cancel sent", () => (outFrames(fixture, "session/cancel").length >= 1 ? true : undefined));
    expect(outFrames(fixture, "session/cancel")).toHaveLength(1);

    const promptsBefore = outFrames(fixture, "session/prompt").length;
    // A following message is refused while the channel stays credit-blocked.
    op.send(`PRIVMSG ${CHANNEL} :again`);
    await until("prompt reported dropped", () => (dropped(fixture, CHANNEL, "credit-blocked").length >= 1 ? true : undefined));
    expect(await op.expectNone(agentSays("ok"), 200)).toBe(true);
    // No new session/prompt reached the agent for the refused message.
    expect(outFrames(fixture, "session/prompt")).toHaveLength(promptsBefore);
  });

  it("leaves other channels unblocked when one channel exceeds the cap", async () => {
    const room = await openRoom(
      {
        turns: [
          { match: "burn", steps: [{ chunk: "burning" }, { metadata: { credits: [{ value: 5, unit: "credit" }] } }] },
          { match: "cheap", steps: [{ chunk: "cheap" }, { metadata: { credits: [{ value: 0.1, unit: "credit" }] } }] },
        ],
      },
      [CHANNEL, OTHER_CHANNEL],
      { env: { SEANCE_CHANNEL_CREDIT_CAP: CAP } },
    );
    const { fixture, op } = room;

    op.send(`PRIVMSG ${CHANNEL} :burn`);
    await op.waitFor(new RegExp(`NOTICE alice :?credit cap reached for ${escapeRegExp(CHANNEL)}`));

    // OTHER_CHANNEL has its own, separate sum: it still answers.
    op.send(`PRIVMSG ${OTHER_CHANNEL} :cheap`);
    await op.waitFor(agentSays("cheap"));
    expect(await op.expectNone(new RegExp(`NOTICE alice :?credit cap reached for ${escapeRegExp(OTHER_CHANNEL)}`), 200)).toBe(true);
    expect(dropped(fixture, OTHER_CHANNEL, "credit-blocked")).toHaveLength(0);
  });
});

describe("!reset-credits (Req 10.11, 10.12, 10.16)", { timeout: TEST_TIMEOUT_MS }, () => {
  const CAP = "1.00";

  /** Starts a room with `#seance1` credit-blocked by one over-cap turn. */
  async function blockedRoom(channels: readonly string[] = [CHANNEL]): Promise<Room> {
    const room = await openRoom(
      {
        turns: [{ match: "spend", steps: [{ chunk: "spending" }, { metadata: { credits: [{ value: 5, unit: "credit" }] } }] }],
      },
      channels,
      { env: { SEANCE_CHANNEL_CREDIT_CAP: CAP } },
    );
    room.op.send(`PRIVMSG ${CHANNEL} :spend`);
    await room.op.waitFor(new RegExp(`NOTICE alice :?credit cap reached for ${escapeRegExp(CHANNEL)}`));
    return room;
  }

  it("clears the block for a human op and lets prompts flow again", async () => {
    const room = await blockedRoom();
    const { fixture, clock, op } = room;

    // Confirm the block is active: a message is dropped, no prompt reaches the agent.
    const promptsBefore = outFrames(fixture, "session/prompt").length;
    op.send(`PRIVMSG ${CHANNEL} :while blocked`);
    await until("blocked prompt dropped", () => (dropped(fixture, CHANNEL, "credit-blocked").length >= 1 ? true : undefined));
    expect(outFrames(fixture, "session/prompt")).toHaveLength(promptsBefore);

    // An op clears the block; the reply names the channel that was cleared.
    op.send("PRIVMSG coder :!reset-credits");
    const reply = await op.waitFor(/^:\S+ NOTICE alice :?credit block cleared for /);
    expect(reply).toContain(CHANNEL); // the cleared channel is named (irc_lower leaves #seance1 unchanged)
    // `!reset-credits` is a command, not a prompt: the agent never sees it.
    expect(await op.expectNone(agentSays("ok"), 200)).toBe(true);

    // A fresh message is no longer refused: it clears the block gate and is dispatched
    // to the agent as a real `session/prompt` (the over-cap turn left the Session in
    // Cooldown, so advance the ManualClock to let the queued prompt flush out).
    op.send(`PRIVMSG ${CHANNEL} :after reset`);
    await (async (): Promise<void> => {
      for (let i = 0; i < 40; i += 1) {
        if (outFrames(fixture, "session/prompt").length > promptsBefore) return;
        clock.advance(1_000);
        await sleep(25);
      }
      throw new Error("the prompt after reset was never dispatched to the agent");
    })();
    // It was sent, not dropped: the block no longer refuses prompts for this channel.
    expect(outFrames(fixture, "session/prompt").length).toBeGreaterThan(promptsBefore);
    expect(dropped(fixture, CHANNEL, "credit-blocked").length).toBe(1); // only "while blocked" was refused
  });

  it("refuses a non-op with the operator-rights NOTICE and keeps the block", async () => {
    const room = await blockedRoom();
    const { fixture, op } = room;
    const bob = await fixture.connectClient("bob");
    await bob.join(CHANNEL); // joins without +o

    bob.send("PRIVMSG coder :!reset-credits");
    const reply = await bob.waitFor(/^:\S+ NOTICE bob :?operator rights \(\+o\) are required/);
    expect(new TextEncoder().encode(`${reply}\r\n`).length).toBeLessThanOrEqual(512);

    // The block is still in place: a channel message is still dropped.
    const promptsBefore = outFrames(fixture, "session/prompt").length;
    op.send(`PRIVMSG ${CHANNEL} :still blocked`);
    await until("prompt still dropped", () => (dropped(fixture, CHANNEL, "credit-blocked").length >= 1 ? true : undefined));
    expect(outFrames(fixture, "session/prompt")).toHaveLength(promptsBefore);
  });

  it("replies 'no channel is credit-blocked' when nothing is blocked (Req 10.16)", async () => {
    // No cap set here, so no channel is ever blocked.
    const room = await openRoom({ turns: [] });
    const { op } = room;
    op.send("PRIVMSG coder :!reset-credits");
    await op.waitFor(/^:\S+ NOTICE alice :?no channel of coder is credit-blocked$/);
  });
});
