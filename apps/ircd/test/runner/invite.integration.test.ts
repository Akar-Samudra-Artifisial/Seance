import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, realpath, rm, writeFile } from "node:fs/promises";
import { sep } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeAllFixtures, startIntegration } from "./integration.js";
import type { IntegrationFixture, IntegrationOptions, IrcTestClient } from "./integration.js";

// Req 3 (invite and join) against the Fake_Agent with an in-process ircd.
// Waiting uses vi.waitFor on the runner's own log records; the only wall-clock
// wait is the fixture's short `expectNone`.

const run = promisify(execFile);
const TEST_TIMEOUT_MS = 60_000;

afterEach(async () => {
  await closeAllFixtures();
});

const frames = (fx: IntegrationFixture, method: string): string[] =>
  fx.logs
    .filter((l) => l.msg.startsWith("acp >>") && typeof l.fields?.["frame"] === "string")
    .map((l) => String(l.fields?.["frame"]))
    .filter((f) => f.includes(`"method":"${method}"`));

const joinedLogs = (fx: IntegrationFixture, channel: string): number =>
  fx.logs.filter((l) => l.msg === "agent joined channel" && l.fields?.["channel"] === channel).length;

const waitSession = (fx: IntegrationFixture, channel: string, count = 1): Promise<void> =>
  vi.waitFor(
    () => {
      if (joinedLogs(fx, channel) < count) throw new Error(`no session for ${channel} yet`);
    },
    { timeout: 20_000, interval: 20 },
  );

const waitLog = (fx: IntegrationFixture, msg: string, count = 1): Promise<void> =>
  vi.waitFor(
    () => {
      if (fx.logs.filter((l) => l.msg === msg).length < count) throw new Error(`log "${msg}" not seen ${count}x`);
    },
    { timeout: 20_000, interval: 20 },
  );

async function opIn(fx: IntegrationFixture, nick: string, channel: string): Promise<IrcTestClient> {
  const client = await fx.connectClient(nick);
  await client.join(channel);
  return client;
}

const agentJoin = (nick: string): RegExp => new RegExp(`^:${nick}!\\S+ JOIN `, "i");
const agentPart = (nick: string): RegExp => new RegExp(`^:${nick}!\\S+ PART `, "i");

async function start(options: IntegrationOptions = {}): Promise<IntegrationFixture> {
  return startIntegration(options);
}

describe("invite and join (integration)", () => {
  it(
    "claims the nick, replies 341, registers, joins with no mode and opens session/new in the worktree",
    async () => {
      const fx = await start();
      const op = await opIn(fx, "alice", "#a");

      op.send("INVITE coder #a");
      await op.waitFor(/^:\S+ 341 alice coder #a/i);
      await op.waitFor(agentJoin("coder"));
      await waitSession(fx, "#a");

      // Registered (001 happened before the JOIN): WHOIS finds the user.
      op.send("WHOIS coder");
      await op.waitFor(/^:\S+ 311 alice coder /i);

      // No mode: neither @ nor + in NAMES.
      op.send("NAMES #a");
      const names = await op.waitFor(/^:\S+ 353 alice \S+ #a /i);
      const members = names.slice(names.indexOf(" :") + 2).split(" ");
      expect(members).toContain("coder");
      expect(members).toContain("@alice");

      // session/new cwd is the channel worktree, registered with git.
      const newFrames = frames(fx, "session/new");
      expect(newFrames).toHaveLength(1);
      const parsed = JSON.parse(newFrames[0] ?? "{}") as { params?: { cwd?: unknown } };
      const cwd = parsed.params?.cwd;
      expect(typeof cwd).toBe("string");
      const root = await realpath(fx.workspaces);
      expect(String(cwd).startsWith(root + sep)).toBe(true);
      expect(existsSync(String(cwd))).toBe(true);
      const list = await run("git", ["-C", fx.repo.path, "worktree", "list", "--porcelain"]);
      expect(list.stdout).toContain(`worktree ${String(cwd)}`);
      expect(await op.expectNone(/^:\S+ NOTICE alice :/)).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "two agents invited back-to-back to one channel both join and share one worktree (no `worktree add` race)",
    async () => {
      const fx = await start();
      const op = await opIn(fx, "alice", "#a");

      op.send("INVITE coder #a");
      op.send("INVITE reviewer #a");
      await op.waitFor(agentJoin("coder"));
      await op.waitFor(agentJoin("reviewer"));
      await waitSession(fx, "#a", 2);

      expect(fx.logs.some((l) => l.msg === "invite pipeline failed")).toBe(false);
      expect(await op.expectNone(/^:\S+ NOTICE alice :/)).toBe(true);

      const cwds = frames(fx, "session/new").map(
        (f) => (JSON.parse(f) as { params?: { cwd?: unknown } }).params?.cwd,
      );
      expect(cwds).toHaveLength(2);
      expect(typeof cwds[0]).toBe("string");
      expect(cwds[0]).toBe(cwds[1]);
      const list = await run("git", ["-C", fx.repo.path, "worktree", "list", "--porcelain"]);
      expect(list.stdout.split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(2); // repo + one channel
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "gives the inviter a NOTICE and creates no state when a non-agent holds the nick",
    async () => {
      const fx = await start();
      const op = await opIn(fx, "alice", "#a");
      const squatter = await fx.connectClient("coder");

      op.send("INVITE coder #a");
      await op.waitFor(/^:\S+ NOTICE alice :.*coder.*(unavailable|in use)/i);

      expect(await squatter.expectNone(agentJoin("coder"))).toBe(true);
      expect(frames(fx, "session/new")).toHaveLength(0);
      expect(existsSync(fx.workspaces) ? await readdir(fx.workspaces) : []).toEqual([]);
      // The existing client is unaffected and still answers.
      squatter.send("PING still-here");
      await squatter.waitFor(/PONG .*still-here/i);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "ignores a duplicate invite silently: no second JOIN, session or NOTICE",
    async () => {
      const fx = await start();
      const op = await opIn(fx, "alice", "#a");

      op.send("INVITE coder #a");
      op.send("INVITE coder #a");
      await op.waitFor(agentJoin("coder"));
      await waitSession(fx, "#a");
      op.send("INVITE coder #a");

      expect(await op.expectNone(/^:\S+ NOTICE alice :/)).toBe(true);
      expect(op.lines.filter((l) => agentJoin("coder").test(l))).toHaveLength(1);
      expect(frames(fx, "session/new")).toHaveLength(1);
      expect(joinedLogs(fx, "#a")).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "sends one rate-limit NOTICE on the sixth invite within a minute",
    async () => {
      const fx = await start();
      const op = await fx.connectClient("alice");
      // Two channels and three agents give six distinct Invite_Keys with few
      // client lines (the ircd's per-connection flood bucket holds 10).
      await op.join("#c1");
      await op.join("#c2");
      const accepted = [
        ["coder", "#c1"],
        ["reviewer", "#c1"],
        ["researcher", "#c1"],
        ["coder", "#c2"],
        ["reviewer", "#c2"],
      ] as const;
      for (const [nick, channel] of accepted) {
        op.send(`INVITE ${nick} ${channel}`);
        await op.waitFor(new RegExp(`^:${nick}!\\S+ JOIN :?${channel}`, "i"));
        await vi.waitFor(
          () => {
            const seen = fx.logs.some(
              (l) =>
                l.msg === "agent joined channel" &&
                l.fields?.["agent"] === nick &&
                l.fields?.["channel"] === channel,
            );
            if (!seen) throw new Error(`${nick} has no session in ${channel} yet`);
          },
          { timeout: 20_000, interval: 20 },
        );
      }
      expect(await op.expectNone(/^:\S+ NOTICE alice :/, 50)).toBe(true);

      op.send("INVITE researcher #c2");
      const notice = await op.waitFor(/^:\S+ NOTICE alice :.*rate limit/i);
      expect(notice).toMatch(/5 per minute/);
      expect(notice).toMatch(/retry in \d+ seconds/);
      expect(await op.expectNone(/^:\S+ NOTICE alice :/)).toBe(true);
      expect(op.lines.some((l) => /^:researcher!\S+ JOIN :?#c2/i.test(l))).toBe(false);
      expect(frames(fx, "session/new")).toHaveLength(5);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "answers 401 for a refused inviter and leaves no state; an allowed inviter still works",
    async () => {
      const fx = await start({ env: { SEANCE_INVITERS: "bob" } });
      const alice = await opIn(fx, "alice", "#a");
      const bob = await opIn(fx, "bob", "#b");

      alice.send("INVITE coder #a");
      await alice.waitFor(/^:\S+ 401 alice coder /i);
      expect(await alice.expectNone(/ 341 |JOIN/)).toBe(true);
      expect(frames(fx, "session/new")).toHaveLength(0);
      expect(existsSync(fx.workspaces) ? await readdir(fx.workspaces) : []).toEqual([]);

      bob.send("INVITE coder #b");
      await bob.waitFor(/^:\S+ 341 bob coder #b/i);
      await bob.waitFor(agentJoin("coder"));
      await waitSession(fx, "#b");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "leaves with PART, notices the channel and releases the key when the worktree fails",
    async () => {
      const fx = await start();
      const op = await opIn(fx, "alice", "#a");
      // A regular file where the workspaces root should be makes worktree creation fail.
      await rm(fx.workspaces, { recursive: true, force: true });
      await writeFile(fx.workspaces, "not a directory");

      op.send("INVITE coder #a");
      await op.waitFor(agentJoin("coder"));
      const notice = await op.waitFor(/^:coder!\S+ NOTICE #a :/i);
      expect(notice).toMatch(/worktree failed/);
      expect(Buffer.byteLength(notice, "utf8")).toBeLessThanOrEqual(510);
      // The NOTICE is generic: no path or errno text; the cause goes to the log only.
      expect(notice).not.toContain(fx.workspaces);
      expect(notice).not.toMatch(/ENOTDIR|ENOENT|EEXIST|git /);
      const logged = fx.logs.find((l) => l.msg === "invite pipeline failed");
      expect(String(logged?.fields?.["cause"])).toMatch(/worktree/);
      await op.waitFor(agentPart("coder"));
      expect(frames(fx, "session/new")).toHaveLength(0);
      expect(joinedLogs(fx, "#a")).toBe(0);

      // The key was released: after fixing the cause the same invite starts a session.
      await rm(fx.workspaces, { force: true });
      op.send("INVITE coder #a");
      await op.waitFor(agentJoin("coder"));
      await waitSession(fx, "#a");
      expect(frames(fx, "session/new")).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "leaves with PART, notices the channel and releases the key when session/new fails",
    async () => {
      const fx = await start({ script: { modeId: "kiro_default", turns: [] } });
      const op = await opIn(fx, "alice", "#a");

      op.send("INVITE coder #a");
      await op.waitFor(agentJoin("coder"));
      await op.waitFor(/^:\S+ NOTICE alice :agent profile \S+ not loaded/i);
      const notice = await op.waitFor(/^:coder!\S+ NOTICE #a :/i);
      expect(notice).toMatch(/session\/new failed/);
      await op.waitFor(agentPart("coder"));
      expect(joinedLogs(fx, "#a")).toBe(0);

      // Released: a second invite is processed again (a fresh JOIN and a second failure).
      op.send("INVITE coder #a");
      await op.waitFor(agentJoin("coder"));
      await op.waitFor(/^:coder!\S+ NOTICE #a :/i);
      await op.waitFor(agentPart("coder"));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "starts the session after /kick with a resume summary wrapped as untrusted",
    async () => {
      const fx = await start();
      const op = await opIn(fx, "alice", "#a");

      op.send("INVITE coder #a");
      await op.waitFor(agentJoin("coder"));
      await waitSession(fx, "#a");
      op.send("PRIVMSG #a :remember the marker-4711 plan");

      op.send("KICK #a coder :out");
      await waitLog(fx, "exorcism finished");
      expect(frames(fx, "session/prompt")).toHaveLength(0);

      op.send("INVITE coder #a");
      await op.waitFor(/^:\S+ 341 alice coder #a/i);
      await waitSession(fx, "#a", 2);
      await vi.waitFor(
        () => {
          const prompts = frames(fx, "session/prompt");
          if (prompts.length === 0) throw new Error("no resume prompt yet");
          const first = prompts[0] ?? "";
          expect(first).toContain("marker-4711");
          expect(first).toContain("<untrusted>");
        },
        { timeout: 20_000, interval: 20 },
      );
      expect(frames(fx, "session/new")).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );
});
