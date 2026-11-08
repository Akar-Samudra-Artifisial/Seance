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

async function makeController(fake: Fake) {
  const mini = new MiniHost();
  const harness = new FakeHarness({ defaultScript: { turns: [] } });
  disposers.push(() => harness.dispose());
  const clock = new ManualClock();
  const timers = new TimerSet(clock);
  const snapshot = new WhoisSnapshot();
  const store = new MemorySessionStore();
  const ledger = new CreditLedger({ store, snapshot, clock, sessionsOf: () => [], opNotice: () => undefined });
  const chanServ: string[] = [];
  const sessions: Session[] = [];
  const shortHeadCalls: string[] = [];
  const controller = new InviteController({
    host: mini.host,
    registry: { lookup: (n) => (irc_lower(n) === "coder" ? PROFILE : undefined) },
    bans: new BanList(),
    inviters: parseInviters(undefined),
    gate: new InviteGate(100),
    sessions: {
      addChannelSession: (s) => void sessions.push(s),
      channelSession: () => undefined,
      registerAgent: () => () => undefined,
    },
    worktrees: {
      ensure: async (channel): Promise<WorktreeInfo> => {
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
    opNotice: () => undefined,
    services: {
      chanServ: (channel, text) => {
        chanServ.push(`${channel}: ${text}`);
        return true;
      },
      workspaces: "/srv/secret/home/workspaces",
    },
  });
  const invite = (channel: string, ts: number): Promise<void> => {
    const e: HostEvents["irc.invite"] = { channel, inviter: "op", target: "coder", targetKey: "coder", targetOnline: false, ts };
    return controller.handleInvite(e);
  };
  return { controller, chanServ, sessions, shortHeadCalls, invite, mini };
}

describe("worktree ready (Req 5)", () => {
  it("is sent once when ensure created the worktree, with two path segments and the short sha", async () => {
    const t = await makeController({ created: true, sha: "a1b2c3d", ensureFails: false });
    await t.invite("#Fix-Bug-123", 1);
    expect(t.chanServ).toEqual(["#Fix-Bug-123: worktree ready: workspaces/fix-bug-123 @ a1b2c3d"]);
    expect(t.chanServ.join("")).not.toContain("/srv");
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
