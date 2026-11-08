import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ManualClock, closeAllFixtures, startIntegration } from "./integration.js";
import type { FakeAgentScript, IntegrationFixture, IntegrationOptions, IrcTestClient } from "./integration.js";

// runner-services Requirements 4 to 7 end to end: ChanServ and NickServ notices from the real runner
// through a real ircd, with the Fake_Agent as `kiro-cli`.

const run = promisify(execFile);
const TEST_TIMEOUT_MS = 40_000;
const CHANNEL = "#svc";
/** Forbidden trademark term from product.md, built from two fragments (Req 9.5). */
const FORBIDDEN = `${"m"}${"irc"}`;

type World = { readonly fx: IntegrationFixture; readonly clock: ManualClock; readonly op: IrcTestClient };

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
const chanServ = (text: string | RegExp): RegExp =>
  new RegExp(`^:ChanServ!ChanServ@services\\.\\S+ NOTICE ${escapeRegExp(CHANNEL)} :${typeof text === "string" ? escapeRegExp(text) : text.source}$`);
const nickServ = (nick: string, text: RegExp): RegExp =>
  new RegExp(`^:NickServ!NickServ@services\\.\\S+ NOTICE ${escapeRegExp(nick)} :${text.source}$`);

async function world(script: FakeAgentScript, options: Omit<IntegrationOptions, "script" | "clock"> = {}): Promise<World> {
  const clock = new ManualClock();
  const fx = await startIntegration({ clock, script, ...options });
  pump = setInterval(() => clock.advance(100), 5); // cooldowns and exorcism polls run on the ManualClock
  const op = await fx.connectClient("op");
  return { fx, clock, op };
}

const shortSha = async (repo: string): Promise<string> =>
  (await run("git", ["-C", repo, "rev-parse", "--short=7", "HEAD"])).stdout.trim();

async function summon(w: World, agent: string, mode = "+o"): Promise<void> {
  w.op.send(`INVITE ${agent} ${CHANNEL}`);
  await w.op.waitFor(new RegExp(`^:${agent}!\\S+ JOIN :?${escapeRegExp(CHANNEL)}$`, "i"), 15_000);
  const deadline = Date.now() + 15_000;
  while (!w.fx.logs.some((l) => l.msg === "agent joined channel" && l.fields?.["agent"] === agent && l.fields?.["channel"] === CHANNEL)) {
    if (Date.now() > deadline) throw new Error(`${agent} never got a Session`);
    await new Promise<void>((r) => setImmediate(r));
  }
  w.op.send(`MODE ${CHANNEL} ${mode} ${agent}`);
  await w.op.waitFor(new RegExp(`MODE ${escapeRegExp(CHANNEL)} \\${mode} ${agent}$`));
}

describe("ChanServ and NickServ (Fake_Agent + in-process ircd)", () => {
  it(
    "worktree ready exactly once for two invites into one channel, with the repo's short sha (Req 5)",
    async () => {
      const w = await world({ turns: [] });
      await w.op.join(CHANNEL);
      await summon(w, "coder");
      await summon(w, "reviewer");
      const sha = await shortSha(w.fx.repo.path);
      const lines = w.op.lines.filter((l) => / NOTICE #svc :worktree ready: /.test(l));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(chanServ(`worktree ready: workspaces/svc @ ${sha}`));
      expect(lines[0]).not.toContain(w.fx.workspaces);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "greets a human with the roster in idle, then shows coder (prompting) while a turn is held (Req 4)",
    async () => {
      const w = await world({ turns: [{ match: "plumbing", steps: [{ chunk: "digging" }, { gate: "hold" }] }] });
      await w.op.waitFor(nickServ("op", /agents online: .+ \(idle\)/));
      const greeting = w.op.lines.find((l) => / NOTICE op :agents online: /.test(l)) ?? "";
      for (const agent of ["coder", "reviewer", "researcher"]) expect(greeting).toContain(agent);
      expect(greeting).not.toContain(";");

      await w.op.join(CHANNEL);
      await summon(w, "coder");
      w.op.send(`PRIVMSG ${CHANNEL} :fix the plumbing`);
      // A space-free trailing parameter may be sent without its `:`; both forms are legal.
      await w.op.waitFor(/^:coder!\S+ PRIVMSG #svc :?\S*digging/);
      const late = await w.fx.connectClient("late");
      const roster = await late.waitFor(nickServ("late", /agents online: .+/));
      expect(roster).toMatch(/coder \(prompting\)/);
      expect(roster).toMatch(/\(idle\)/);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "kick during a held turn: session cancelled, files reverted with the WHOIS credits (Req 6, 7.3)",
    async () => {
      const w = await world({
        turns: [
          {
            match: "plumbing",
            steps: [{ metadata: { credits: [{ value: 1.25, unit: "credit" }] } }, { chunk: "digging" }, { gate: "hold" }],
          },
        ],
      });
      await w.op.join(CHANNEL);
      await summon(w, "coder");
      const sha = await shortSha(w.fx.repo.path);
      w.op.send(`PRIVMSG ${CHANNEL} :fix the plumbing`);
      await w.op.waitFor(/^:coder!\S+ PRIVMSG #svc :?\S*digging/);
      // The Fake_Agent cannot write files; the test plays its part in the channel worktree.
      const wt = join(w.fx.workspaces, "svc");
      for (const f of ["a.txt", "b.txt", "c.txt"]) await writeFile(join(wt, f), "agent output\n");

      w.op.send("WHOIS coder");
      const credits = await w.op.waitFor(/ 320 op coder :credits: #svc /);
      const used = /credits: #svc (\d+\.\d\d) /.exec(credits)?.[1];
      expect(used).toBe("1.25");

      w.op.send(`KICK ${CHANNEL} coder :scope creep`);
      await w.op.waitFor(chanServ(`session cancelled, worktree reset to ${sha}`), 15_000);
      await w.op.waitFor(chanServ(`3 files reverted · ${String(used)} credits used`), 15_000);
      const notices = w.op.lines.filter((l) => / NOTICE /.test(l));
      expect(notices.some((l) => /restored/i.test(l))).toBe(false);
      expect(notices.some((l) => l.toLowerCase().includes(FORBIDDEN))).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "kick of an idle agent: session closed, and no second line when nothing was reverted (Req 6.1, 6.3)",
    async () => {
      const w = await world({ turns: [] });
      await w.op.join(CHANNEL);
      await summon(w, "coder");
      const sha = await shortSha(w.fx.repo.path);
      w.op.send(`KICK ${CHANNEL} coder :bye`);
      await w.op.waitFor(chanServ(`session closed, worktree reset to ${sha}`), 15_000);
      expect(await w.op.expectNone(/ NOTICE #svc :\d+ files? reverted/, 800)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "sends no NickServ roster before the runner has started (Req 4.3)",
    async () => {
      const clock = new ManualClock();
      const fx = await startIntegration({ clock, script: { turns: [] }, autoStart: false });
      const early = await fx.connectClient("early");
      expect(await early.expectNone(/NickServ/, 500)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});
