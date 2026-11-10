// runner-services Requirement 5 (task 6.3): `worktree ready` from the invite pipeline, with a fake
// WorktreeManager and a small in-memory IRC host. Property 5 (gating) is model-based over invites.
import type { IrcMessage } from "@seance/irc-protocol";
import { Numerics, irc_lower } from "@seance/irc-protocol";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { TimerSet } from "../src/clock.js";
import { CreditLedger } from "../src/credits/ledger.js";
import { parseInviters } from "../src/invite/allow-list.js";
import { BanList } from "../src/invite/ban-list.js";
import { InviteController } from "../src/invite/invite-controller.js";
import { InviteGate } from "../src/invite/invite-gate.js";
import type { RunnerLogger } from "../src/log.js";
import type { HostChannel, HostEvents, HostMembership, HostVirtualClient, IrcHost } from "../src/ports.js";
import { ChannelLog } from "../src/prompt/channel-log.js";
import type { AgentProfile } from "../src/registry/agent-profile.js";
import { MemorySessionStore } from "../src/session/memory-session-store.js";
import type { Session } from "../src/session/session.js";
import { WhoisSnapshot } from "../src/whois/snapshot.js";
import type { WorktreeInfo } from "../src/worktree/worktree-manager.js";
import type { AgentHarness } from "../src/harness/harness.js";
import { SandboxError } from "../src/sandbox/errors.js";
import { FakeHarness } from "./fixtures/fake-harness.js";
import { ManualClock } from "./fixtures/manual-clock.js";

const PROFILE: AgentProfile = { nick: "coder", kiroAgent: "coder", model: "m", tools: "t", color: 12, file: "coder.json" };
const quiet: RunnerLogger = { debug() {}, info() {}, warn() {}, error() {} };

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of disposers.splice(0)) await fn();
});

/** The pieces of the ircd the controller touches: registration, JOIN membership, notices. */
class MiniHost {
  readonly members = new Map<string, Map<string, HostMembership>>();
  readonly notices: string[] = [];
  readonly host: IrcHost;
  constructor() {
    const members = this.members;
    this.host = {
      serverName: "seance.test",
      createVirtualClient: (o) => {
        let listener: ((m: IrcMessage) => void) | undefined;
        let nick = "";
        const client: HostVirtualClient = {
          id: o.id,
          get nick() {
            return nick;
          },
          virtual: true,
          send: () => undefined,
          dispatch: (msg) => {
            if (msg.command === "NICK") nick = msg.params[0] ?? "";
            if (msg.command === "USER") listener?.({ prefix: "seance.test", command: Numerics.RPL_WELCOME, params: [nick, "hi"] });
            if (msg.command === "JOIN") {
              const ch = irc_lower(msg.params[0] ?? "");
              const set = members.get(ch) ?? new Map<string, HostMembership>();
              set.set(irc_lower(nick), { op: false, voice: false });
              members.set(ch, set);
            }
            // agent-sandbox Requirement 11.5: the failure path parts the channel.
            if (msg.command === "PART") members.get(irc_lower(msg.params[0] ?? ""))?.delete(irc_lower(nick));
            return undefined;
          },
          onMessage: (l) => {
            listener = l;
            return () => {
              listener = undefined;
            };
          },
          setAway: () => undefined,
          close: () => undefined,
        };
        return client;
      },
      subscribe: () => () => undefined,
      clientByNick: () => undefined,
      clientById: () => undefined,
      channel: (name): HostChannel | undefined =>
        members.has(irc_lower(name)) ? { name, modes: { moderated: false }, members: new Map() } : undefined,
      modeOf: (channel, nick) => members.get(irc_lower(channel))?.get(irc_lower(nick)),
      noticeTo: (nick, text) => {
        this.notices.push(`${nick}: ${text}`);
        return true;
      },
      serviceNotice: () => true,
    };
  }
}

type Fake = {
  created: boolean;
  sha: string | undefined;
  ensureFails: boolean;
};

async function makeController(
  fake: Fake,
  extra: {
    readonly openSession?: AgentHarness["openSession"];
    readonly opNotices?: string[];
    readonly sandboxMode?: "none" | "podman";
    readonly profile?: AgentProfile;
    /** Task 27.4: replaces `worktrees.ensure` (e.g. one that never settles). */
    readonly ensure?: (channel: string) => Promise<WorktreeInfo>;
    /** Task 27.4: what the fake startup queue reports at readiness and on failure. */
    readonly queue?: { readonly ready: { delivered: number; dropped: number }; readonly failed: number };
    readonly worktreeTimeoutMs?: number;
  } = {},
) {
  const mini = new MiniHost();
  const fakeHarness = new FakeHarness({ defaultScript: { turns: [] } });
  disposers.push(() => fakeHarness.dispose());
  const harness: Pick<AgentHarness, "openSession"> =
    extra.openSession !== undefined ? { openSession: extra.openSession } : fakeHarness;
  const clock = new ManualClock();
  const timers = new TimerSet(clock);
  const snapshot = new WhoisSnapshot();
  const store = new MemorySessionStore();
  const ledger = new CreditLedger({ store, snapshot, clock, sessionsOf: () => [], opNotice: () => undefined });
  const chanServ: string[] = [];
  const ready: string[] = [];
  const starts: string[] = [];
  const dropNotices: string[] = [];
  let failedOnce = false;
  const sessions: Session[] = [];
  const shortHeadCalls: string[] = [];
  const profile = extra.profile ?? PROFILE;
  const controller = new InviteController({
    // Review finding 6: sandboxMode is required; these tests run as SEANCE_SANDBOX=none unless told.
    sandboxMode: extra.sandboxMode ?? "none",
    host: mini.host,
    registry: { lookup: (n) => (irc_lower(n) === "coder" ? profile : undefined) },
    bans: new BanList(),
    inviters: parseInviters(undefined),
    gate: new InviteGate(100),
    sessions: {
      addChannelSession: (s) => void sessions.push(s),
      channelSession: () => undefined,
      registerAgent: () => () => undefined,
      ...(extra.queue !== undefined
        ? {
            beginStart: (agent: string, channel: string) => void starts.push(`begin ${agent} ${channel}`),
            startReady: () => extra.queue?.ready ?? { delivered: 0, dropped: 0 },
            // The real queue reports its size once, then 0 (it is gone).
            startFailed: (agent: string, channel: string) => {
              starts.push(`failed ${agent} ${channel}`);
              const first = !failedOnce;
              failedOnce = true;
              return first ? (extra.queue?.failed ?? 0) : 0;
            },
          }
        : {}),
    },
    ...(extra.worktreeTimeoutMs !== undefined ? { worktreeTimeoutMs: extra.worktreeTimeoutMs } : {}),
    worktrees: {
      ensure: async (channel): Promise<WorktreeInfo> => {
        if (extra.ensure !== undefined) return extra.ensure(channel);
        if (fake.ensureFails) throw new Error("git worktree add failed");
        return { path: `/ws/${channel}`, realPath: `/tmp/seance-fake-${channel}`, branch: "seance/x", created: fake.created };
      },
      guardBeforePrompt: async () => ({ ok: true }),
      shortHead: async (channel) => {
        shortHeadCalls.push(channel);
        return fake.sha;
      },
    },
    harness,
    snapshot,
    ledger,
    store,
    channelLog: new ChannelLog(),
    clock,
    timers,
    logger: quiet,
    opNotice: (_channel, text) => void extra.opNotices?.push(text),
    services: {
      chanServ: (channel, text) => {
        // agent-runner Requirement 3.24 added "<agent> is ready"; kept apart so the worktree-ready
        // assertions below still see only their own notice.
        (text.endsWith(" is ready") ? ready : text.includes(" queued message") ? dropNotices : chanServ).push(
          `${channel}: ${text}`,
        );
        return true;
      },
      workspaces: "/srv/secret/home/workspaces",
    },
  });
  const invite = (channel: string, ts: number): Promise<void> => {
    const e: HostEvents["irc.invite"] = { channel, inviter: "op", target: "coder", targetKey: "coder", targetOnline: false, ts };
    return controller.handleInvite(e);
  };
  return { controller, chanServ, ready, starts, dropNotices, sessions, shortHeadCalls, invite, mini, snapshot, clock };
}

describe("worktree ready (Req 5)", () => {
  it("is sent once when ensure created the worktree, with two path segments and the short sha", async () => {
    const t = await makeController({ created: true, sha: "a1b2c3d", ensureFails: false });
    await t.invite("#Fix-Bug-123", 1);
    expect(t.chanServ).toEqual(["#Fix-Bug-123: worktree ready: workspaces/fix-bug-123 @ a1b2c3d"]);
    expect(t.chanServ.join("")).not.toContain("/srv");
    // Requirement 3.24: one "ready" notice once the Session exists, also when no worktree was created.
    expect(t.ready).toEqual(["#Fix-Bug-123: coder is ready"]);
    expect(t.sessions).toHaveLength(1);
  });

  it("is not sent when the worktree was reused", async () => {
    const t = await makeController({ created: false, sha: "a1b2c3d", ensureFails: false });
    await t.invite("#dev", 1);
    expect(t.chanServ).toEqual([]);
    expect(t.shortHeadCalls).toEqual([]);
  });

  it("is not sent, and has no placeholder, when the short sha cannot be read", async () => {
    const t = await makeController({ created: true, sha: undefined, ensureFails: false });
    await t.invite("#dev", 1);
    expect(t.chanServ).toEqual([]);
    expect(t.sessions).toHaveLength(1); // the invite itself still succeeds
  });

  it("is not sent when ensure rejects", async () => {
    const t = await makeController({ created: true, sha: "a1b2c3d", ensureFails: true });
    await t.invite("#dev", 1);
    expect(t.chanServ).toEqual([]);
    expect(t.sessions).toEqual([]);
  });
});

describe("P5 notices only when true", () => {
  it("P5 notices only when true: worktree ready iff created and the sha resolves", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ created: fc.boolean(), sha: fc.option(fc.stringMatching(/^[0-9a-f]{7}$/), { nil: undefined }), ensureFails: fc.boolean() }), {
          minLength: 1,
          maxLength: 4,
        }),
        async (steps) => {
          const fake: Fake = { created: false, sha: undefined, ensureFails: false };
          const t = await makeController(fake);
          const expected: string[] = [];
          for (const [i, step] of steps.entries()) {
            Object.assign(fake, step);
            const channel = `#c${String(i)}`;
            await t.invite(channel, i + 1);
            if (!step.ensureFails && step.created && step.sha !== undefined) {
              expected.push(`${channel}: worktree ready: workspaces/c${String(i)} @ ${step.sha}`);
            }
          }
          expect(t.chanServ).toEqual(expected);
        },
      ),
      { numRuns: 25 },
    );
  });
});

describe("sandbox start failure (agent-sandbox Requirement 11)", () => {
  it("sends the ops one notice with the fixed reason, parts, registers nothing and releases the key", async () => {
    const opNotices: string[] = [];
    const t = await makeController(
      { created: false, sha: "a1b2c3d", ensureFails: false },
      {
        openSession: () => Promise.reject(new SandboxError("image-missing", "internal detail /srv/secret")),
        opNotices,
      },
    );
    await t.invite("#dev", 1);
    expect(opNotices).toEqual(["sandbox: coder not started in #dev: sandbox image not found"]);
    expect(t.sessions).toEqual([]);
    expect(t.mini.members.get("#dev")?.has("coder")).toBe(false);
    // The Invite_Key was released: the same invite is handled again, not dropped as a duplicate.
    await t.invite("#dev", 2);
    expect(opNotices).toHaveLength(2);
  });

  it("a start failure carries the scrubbed podman stderr tail", async () => {
    const opNotices: string[] = [];
    const t = await makeController(
      { created: false, sha: "a1b2c3d", ensureFails: false },
      { openSession: () => Promise.reject(new SandboxError("start-failed", "x", "Error: crun: <path>: denied")), opNotices },
    );
    await t.invite("#dev", 1);
    expect(opNotices).toEqual(["sandbox: coder not started in #dev: container failed to start: Error: crun: <path>: denied"]);
  });
});

describe("WHOIS tools label follows the required sandboxMode (review finding 6)", () => {
  const shellProfile: AgentProfile = { ...PROFILE, tools: "fs, git, shell(sandbox)", skills: ["seance-fix-and-commit"] };
  it.each([
    ["none", "fs, git, shell(host)"],
    ["podman", "fs, git, shell(sandbox)"],
  ] as const)("registers the %s label and the skills", async (mode, tools) => {
    const t = await makeController({ created: false, sha: undefined, ensureFails: false }, { sandboxMode: mode, profile: shellProfile });
    await t.invite("#dev", 1);
    expect(t.snapshot.get("coder")?.tools).toBe(tools);
    expect(t.snapshot.get("coder")?.skills).toEqual(["seance-fix-and-commit"]);
  });
});

// agent-runner task 27.4 (Requirements 3.28, 3.29): drop notices and the worktree timeout.
describe("startup queue drop notice and worktree timeout", () => {
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 60; i++) await Promise.resolve();
  };

  it("sends one drop notice when queued messages are dropped at readiness, with the nick and count only", async () => {
    const t = await makeController(
      { created: false, sha: "a1b2c3d", ensureFails: false },
      { queue: { ready: { delivered: 1, dropped: 2 }, failed: 0 } },
    );
    await t.invite("#dev", 1);
    expect(t.dropNotices).toEqual(["#dev: coder dropped 2 queued messages"]);
    expect(t.ready).toEqual(["#dev: coder is ready"]);
  });

  it("sends no drop notice when nothing was dropped", async () => {
    const t = await makeController(
      { created: false, sha: "a1b2c3d", ensureFails: false },
      { queue: { ready: { delivered: 3, dropped: 0 }, failed: 0 } },
    );
    await t.invite("#dev", 1);
    expect(t.dropNotices).toEqual([]);
  });

  it("sends one drop notice when the start fails", async () => {
    const t = await makeController(
      { created: false, sha: "a1b2c3d", ensureFails: false },
      { openSession: () => Promise.reject(new Error("boom")), queue: { ready: { delivered: 0, dropped: 0 }, failed: 1 } },
    );
    await t.invite("#dev", 1);
    expect(t.dropNotices).toEqual(["#dev: coder dropped 1 queued message"]);
  });

  it("times out a hung worktree ensure, fails the start and clears the queue", async () => {
    const t = await makeController(
      { created: false, sha: "a1b2c3d", ensureFails: false },
      {
        ensure: () => new Promise<WorktreeInfo>(() => undefined), // git never returns
        worktreeTimeoutMs: 1_000,
        queue: { ready: { delivered: 0, dropped: 0 }, failed: 2 },
      },
    );
    const done = t.invite("#dev", 1);
    await settle();
    expect(t.starts).toEqual(["begin coder #dev"]);
    t.clock.advance(999);
    await settle();
    expect(t.starts).toEqual(["begin coder #dev"]);
    t.clock.advance(1);
    await done;
    expect(t.starts).toEqual(["begin coder #dev", "failed coder #dev"]);
    expect(t.dropNotices).toEqual(["#dev: coder dropped 2 queued messages"]);
    expect(t.sessions).toEqual([]);
    expect(t.mini.members.get("#dev")?.has("coder")).toBe(false); // parted
    expect(t.mini.notices).toEqual([]);
  });
});
