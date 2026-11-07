import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clampTrailing } from "../../src/text-limits.js";
import { budgetFor } from "../../../runner/src/output/line-format.js";
import { closeAllFixtures, startIntegration } from "./integration.js";
import type { FakeAgentScript, IntegrationFixture, IntegrationOptions, IrcTestClient } from "./integration.js";

// Req 5.1, 5.3, 5.4, 5.7, 5.8, 5.9, 7.2, 7.5, 7.6, 7.8 against a real ircd and the Fake_Agent.

const CHANNEL = "#flow";
/** `coder.json` uses color 12; the runner writes it as `\x03` + two digits. */
const COLOR_OPEN = "\x0312";
const COLOR_RESET = "\x0F";
const TEST_TIMEOUT_MS = 30_000;

afterEach(async () => {
  await closeAllFixtures();
});

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Matches one colored PRIVMSG from `nick` to `target` carrying exactly `text`. */
const agentSays = (nick: string, target: string, text: string): RegExp =>
  new RegExp(
    `^:${escapeRegExp(nick)}![^ ]+ PRIVMSG ${escapeRegExp(target)} :?${escapeRegExp(COLOR_OPEN)}${escapeRegExp(text)}${escapeRegExp(COLOR_RESET)}$`,
  );

const anyPrivmsgFrom = (nick: string): RegExp => new RegExp(`^:${escapeRegExp(nick)}![^ ]+ PRIVMSG `);

const turn = (match: string, ...chunks: readonly string[]): { match: string; steps: { chunk: string }[] } => ({
  match,
  steps: chunks.map((chunk) => ({ chunk })),
});

const sessionReady = async (fx: IntegrationFixture, channel: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  const joined = (): boolean =>
    fx.logs.some((l) => l.msg === "agent joined channel" && l.fields?.["channel"] === channel);
  while (!joined()) {
    if (Date.now() > deadline) throw new Error(`no Session was created in ${channel}; logs: ${JSON.stringify(fx.logs.slice(-5))}`);
    await new Promise<void>((r) => setImmediate(r));
  }
};

const setMode = async (op: IrcTestClient, observer: IrcTestClient, args: string, echo: RegExp): Promise<void> => {
  op.send(`MODE ${CHANNEL} ${args}`);
  await observer.waitFor(echo);
};

/** Op joins the channel, invites `coder`, and waits until its Session exists. */
const inviteCoder = async (fx: IntegrationFixture, op: IrcTestClient, nick: string, channel = CHANNEL): Promise<void> => {
  op.send(`INVITE ${nick} ${channel}`);
  try {
    await op.waitFor(new RegExp(`^:\\S+ 341 \\S+ ${escapeRegExp(nick)} `));
    await op.waitFor(new RegExp(`^:${escapeRegExp(nick)}!\\S+ JOIN :?${escapeRegExp(channel)}$`, "i"));
    await sessionReady(fx, channel);
  } catch (error) {
    const errors = fx.logs.filter((l) => l.level !== "debug").slice(-10);
    throw new Error(`invite of ${nick} failed: ${String(error)}\nrunner logs: ${JSON.stringify(errors)}`);
  }
};

type Scene = { readonly fx: IntegrationFixture; readonly op: IrcTestClient };

const scene = async (
  script: FakeAgentScript,
  options: Omit<IntegrationOptions, "script"> = {},
): Promise<Scene> => {
  const fx = await startIntegration({ script, ...options });
  const op = await fx.connectClient("op1");
  await op.join(CHANNEL);
  await inviteCoder(fx, op, "coder");
  return { fx, op };
};

describe("message flow (Fake_Agent + in-process ircd)", () => {
  it(
    "turns a human op's message into a prompt and returns the chunks as colored PRIVMSG lines (Req 5.1, 5.3, 7.2, 7.5)",
    async () => {
      const { op } = await scene({
        turns: [turn("^\\[#flow\\] <@op1> do the thing$", "First sentence. ", "Second one!")],
      });
      await setMode(op, op, "+o coder", /MODE #flow \+o coder$/);

      op.send(`PRIVMSG ${CHANNEL} :do the thing`);
      // The scripted turn only matches the exact template: "@" before the nick, no wrapper.
      await op.waitFor(agentSays("coder", CHANNEL, "First sentence."));
      await op.waitFor(/ PRIVMSG #flow :\x0312 ?Second one!\x0F$/);
      expect(op.lines.some((l) => /PRIVMSG #flow :\x0312ok\x0F$/.test(l))).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "wraps a voiced human's text in <untrusted> (Req 5.4)",
    async () => {
      const { fx, op } = await scene({
        turns: [turn("^\\[#flow\\] <vox> <untrusted>hello from voice</untrusted>$", "Saw the untrusted wrapper.")],
      });
      await setMode(op, op, "+o coder", /MODE #flow \+o coder$/);
      const vox = await fx.connectClient("vox");
      await vox.join(CHANNEL);
      await setMode(op, vox, "+v vox", /MODE #flow \+v vox$/);

      vox.send(`PRIVMSG ${CHANNEL} :hello from voice`);
      await op.waitFor(agentSays("coder", CHANNEL, "Saw the untrusted wrapper."));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "sends no prompt to an Agent without a mode, nor under +m until it is voiced (Req 5.7, 5.8)",
    async () => {
      const { op } = await scene({
        turns: [turn("^\\[#flow\\] <@op1> after voice$", "Voiced reply.")],
      });

      // Invited Agents have no mode: listen only (Req 5.8).
      op.send(`PRIVMSG ${CHANNEL} :hello nobody`);
      expect(await op.expectNone(anyPrivmsgFrom("coder"))).toBe(true);

      // Under +m an Agent with neither +v nor +o stays silent (Req 5.7).
      await setMode(op, op, "+m", /MODE #flow \+m$/);
      op.send(`PRIVMSG ${CHANNEL} :still nobody`);
      expect(await op.expectNone(anyPrivmsgFrom("coder"))).toBe(true);

      // Voiced under +m: the next message is the first prompt it ever sees.
      await setMode(op, op, "+v coder", /MODE #flow \+v coder$/);
      op.send(`PRIVMSG ${CHANNEL} :after voice`);
      await op.waitFor(agentSays("coder", CHANNEL, "Voiced reply."));
      expect(op.lines.some((l) => /PRIVMSG #flow :\x0312ok\x0F$/.test(l))).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "routes a private message to a separate Private_Session that answers the human, not the channel (Req 5.9)",
    async () => {
      const { fx, op } = await scene({
        turns: [
          turn("^\\[private\\] <op1> secret question$", "Private answer."),
          turn("^\\[#flow\\] <@op1> channel question$", "Channel answer."),
        ],
      });
      await setMode(op, op, "+o coder", /MODE #flow \+o coder$/);
      const vox = await fx.connectClient("vox");
      await vox.join(CHANNEL);

      op.send("PRIVMSG coder :secret question");
      await op.waitFor(agentSays("coder", "op1", "Private answer."));
      // The channel never sees the private reply.
      expect(await vox.expectNone(/Private answer/)).toBe(true);

      // The channel Session is still separate and unaffected.
      op.send(`PRIVMSG ${CHANNEL} :channel question`);
      await op.waitFor(agentSays("coder", CHANNEL, "Channel answer."));
      await vox.waitFor(agentSays("coder", CHANNEL, "Channel answer."));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "delivers the longest line (30-byte nick, 63-byte host, long channel) to a peer untruncated (Req 7.5, 7.6)",
    async () => {
      const nick = "n".repeat(30);
      const channel = `#${"é".repeat(49)}`; // 50 characters (the ircd's limit), 99 bytes
      const host = "h".repeat(63);
      // The runner registers the Agent with USER = lower-case nick cut to the ircd's USERLEN (18).
      const expectedPrefix = `${nick}!${nick.slice(0, 18)}@${host}`;
      const budget = budgetFor(expectedPrefix, channel);
      const text = "x".repeat(budget); // no sentence end: flushed when the turn ends
      const fx = await startIntegration({
        serverName: host,
        autoStart: false,
        script: { turns: [turn("^\\[[^\\]]+\\] <@op1> hello long$", text)] },
      });
      await writeFile(
        join(fx.agentsDir, "longnick.json"),
        JSON.stringify({ nick, kiroAgent: "coder", model: "m", tools: "t", color: 12 }),
      );
      await fx.runner.start();
      const op = await fx.connectClient("op1");
      await op.join(channel);
      await inviteCoder(fx, op, nick, channel);
      op.send(`MODE ${channel} +o ${nick}`);
      await op.waitFor(/ MODE \S+ \+o n+$/);

      // Learn the exact prefix the ircd uses for the Agent from its JOIN line.
      const joinLine = op.lines.find((l) => l.startsWith(`:${nick}!`) && / JOIN /.test(l));
      expect(joinLine).toBeDefined();
      const prefix = (joinLine ?? "").slice(1, (joinLine ?? "").indexOf(" "));
      expect(prefix).toBe(expectedPrefix);

      const colored = `${COLOR_OPEN}${text}${COLOR_RESET}`;
      // budgetFor never exceeds what the ircd's clampTrailing keeps: the two limits agree.
      expect(clampTrailing(prefix, "PRIVMSG", [channel], colored)).toBe(colored);

      op.send(`PRIVMSG ${channel} :hello long`);
      const line = await op.waitFor(new RegExp(`^:${escapeRegExp(prefix)} PRIVMSG `));
      // The serializer may omit the `:` of a space-free trailing parameter; both forms are legal.
      const head = `:${prefix} PRIVMSG ${channel} `;
      expect(line.startsWith(head)).toBe(true);
      expect(line.slice(head.length).replace(/^:/, "")).toBe(colored);
      expect(Buffer.byteLength(`${line}\r\n`, "utf8")).toBeLessThanOrEqual(512);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "does not execute agent text such as /kick x (Req 7.8)",
    async () => {
      const { op } = await scene({
        turns: [turn("^\\[#flow\\] <@op1> try to kick me$", "/kick op1 bye\n", "KICK #flow op1\n", "/quit\n")],
      });
      await setMode(op, op, "+o coder", /MODE #flow \+o coder$/);

      op.send(`PRIVMSG ${CHANNEL} :try to kick me`);
      await op.waitFor(agentSays("coder", CHANNEL, "/kick op1 bye"));
      await op.waitFor(agentSays("coder", CHANNEL, "KICK #flow op1"));
      await op.waitFor(agentSays("coder", CHANNEL, "/quit"));
      expect(await op.expectNone(/ (KICK|QUIT) /)).toBe(true);

      // op1 is still a channel member: its message still reaches the channel peers.
      op.send("NAMES #flow");
      const names = await op.waitFor(/^:\S+ 353 /);
      expect(names).toMatch(/@op1/);
    },
    TEST_TIMEOUT_MS,
  );
});
