import { irc_lower, Numerics } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import type { Clock, TimerSet } from "../clock.js";
import type { CreditLedger } from "../credits/ledger.js";
import { AgentProfileNotLoadedError } from "../harness/acp-harness.js";
import type { AgentHarness, HarnessSession } from "../harness/harness.js";
import type { RunnerLogger } from "../log.js";
import { AgentOutput, truncateBytes } from "../output/agent-output.js";
import type { SecretRedactor } from "../output/secret-redactor.js";
import type { HostEvents, HostVirtualClient, IrcHost, Unsubscribe } from "../ports.js";
import { buildResumePrompt } from "../prompt/builder.js";
import type { ChannelLog } from "../prompt/channel-log.js";
import type { AgentProfile } from "../registry/agent-profile.js";
import type { AgentRegistry } from "../registry/agent-registry.js";
import { Session } from "../session/session.js";
import type { SessionManager } from "../session/session-manager.js";
import { inviteKey } from "../session/session-manager.js";
import type { SessionStore } from "../session/session-store.js";
import { worktreeNoticeDir, worktreeReady } from "../services/notices.js";
import { SandboxError } from "../sandbox/errors.js";
import { sandboxNotice } from "../sandbox/notices.js";
import { renderWhois } from "../whois/render.js";
import { toolsLabel } from "../whois/tools-label.js";
import type { ToolsSandboxMode } from "../whois/tools-label.js";
import type { WhoisSnapshot } from "../whois/snapshot.js";
import type { WorktreeInfo, WorktreeManager } from "../worktree/worktree-manager.js";
import type { AllowList } from "./allow-list.js";
import { buildChannelSession, channelPermissionHandler } from "./channel-session.js";
import type { BanList } from "./ban-list.js";
import type { InviteGate } from "./invite-gate.js";

/** Req 3.2: registration (001) must complete within 5 s. */
export const REGISTER_TIMEOUT_MS = 5_000;
/** Req 3.4: `session/new` must complete within 30 s of the join. */
export const SESSION_OPEN_TIMEOUT_MS = 30_000;

export type InviteControllerDeps = {
  readonly host: IrcHost;
  readonly registry: Pick<AgentRegistry, "lookup">;
  readonly bans: Pick<BanList, "has">;
  readonly inviters: AllowList;
  readonly gate: Pick<InviteGate, "decide" | "release">;
  readonly sessions: Pick<SessionManager, "addChannelSession" | "channelSession" | "registerAgent"> &
    Partial<Pick<SessionManager, "setInviter">>;
  /**
   * public-hardening Requirement 5.5: a refusal text when one more agent channel or session would
   * pass `SEANCE_MAX_AGENT_CHANNELS` / `SEANCE_MAX_CONTAINERS`; undefined allows the invite.
   * `pendingChannels` are the channels of starts still in flight.
   */
  readonly capacity?: (channel: string, pendingChannels: readonly string[]) => string | undefined;
  /** The WHOIS `budget:` line (Requirement 5.4); absent means none. */
  readonly budgetLine?: () => string | undefined;
  readonly worktrees: Pick<WorktreeManager, "ensure" | "guardBeforePrompt"> &
    Partial<Pick<WorktreeManager, "shortHead" | "exceedsCap" | "reset">>;
  /**
   * ChanServ voice and the workspaces root for `worktree ready` (runner-services Req 5); optional
   * (design D12). `workspaces` only feeds `worktreeNoticeDir`, never IRC directly.
   */
  readonly services?: { readonly chanServ: (channel: string, text: string) => boolean; readonly workspaces: string };
  readonly harness: Pick<AgentHarness, "openSession">;
  readonly snapshot: WhoisSnapshot;
  readonly ledger: Pick<CreditLedger, "amount" | "recordMetering">;
  readonly store: Pick<SessionStore, "put">;
  readonly channelLog: Pick<ChannelLog, "lines">;
  readonly clock: Clock;
  readonly timers: TimerSet;
  readonly logger: RunnerLogger;
  /** One server-prefixed NOTICE per Human_Op of the channel. */
  readonly opNotice: (channel: string, text: string) => void;
  /** Credit-blocked check for the channel; defaults to never blocked. */
  readonly isBlocked?: (channel: string) => boolean;
  /** Called with each Session this controller creates and its harness session. */
  readonly onHarnessSession?: (session: Session, harnessSession: HarnessSession) => void;
  /** Secret values (for example KIRO_API_KEY) removed from everything the agents say. */
  readonly secrets?: readonly (string | undefined)[];
  /** public-hardening Requirement 6.2: one redactor shared by every agent (Kiro token values). */
  readonly redactor?: SecretRedactor;
  readonly registerTimeoutMs?: number;
  readonly sessionOpenTimeoutMs?: number;
  /** agent-sandbox Requirement 14 (podman mode only): host-side commit after an `end_turn`. */
  readonly commitTurn?: (agent: string, channel: string) => Promise<void>;
  /**
   * web-client-extras Req 6: decides the `shell(host)` / `shell(sandbox)` label in WHOIS. Required, so
   * no caller can show the wrong label by forgetting it.
   */
  readonly sandboxMode: ToolsSandboxMode;
};

type AgentEntry = {
  readonly profile: AgentProfile;
  readonly client: HostVirtualClient;
  readonly output: AgentOutput;
};

type Step = "register" | "join" | "worktree" | "session/new";

/** A pipeline step failed; carries the step name for the channel NOTICE. */
class StepError extends Error {
  readonly step: Step;
  override readonly cause: unknown;
  constructor(step: Step, cause: unknown) {
    super(`${step} failed: ${messageOf(cause)}`);
    this.name = "StepError";
    this.step = step;
    this.cause = cause;
  }
}

class AbortedError extends Error {
  constructor() {
    super("invite pipeline aborted");
    this.name = "AbortedError";
  }
}

class NickInUseError extends Error {
  constructor(nick: string) {
    super(`nick ${nick} is in use`);
    this.name = "NickInUseError";
  }
}

type Pending = {
  aborted: boolean;
  done: Promise<void>;
};

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Resume prompts get ids far from the SessionManager's counter, which starts at 1. */
const RESUME_ID_BASE = Number.MAX_SAFE_INTEGER;

/** The ircd's USERLEN: longest USER name it accepts. */
const MAX_USER_LENGTH = 18;

/**
 * Handles `irc.invite` for Agent nicks (Requirement 3). Dedup and rate limit
 * run synchronously before any work; the pipeline then registers the virtual
 * client, joins (leaving no mode), ensures the Worktree and opens the ACP session.
 */
export class InviteController {
  readonly #d: InviteControllerDeps;
  readonly #agents = new Map<string, AgentEntry>();
  readonly #creating = new Map<string, Promise<AgentEntry>>();
  readonly #pending = new Map<string, Pending>();
  readonly #started = new Set<string>();
  #resumeSeq = 0;

  constructor(deps: InviteControllerDeps) {
    this.#d = deps;
  }

  /** Subscribes to `irc.invite` on the host. */
  attach(): Unsubscribe {
    return this.#d.host.subscribe("irc.invite", (e) => {
      void this.handleInvite(e);
    });
  }

  /** Channel Session starts still in flight (public-hardening Requirement 12.3: container count). */
  pendingStarts(): number {
    return this.#pending.size;
  }

  /** The virtual client of an Agent, once created. */
  agentClient(nick: string): HostVirtualClient | undefined {
    return this.#agents.get(irc_lower(nick))?.client;
  }

  /** Flags an in-flight start for the pair as aborted (Exorcism) and resolves when it settled. */
  async abort(agent: string, channel: string): Promise<void> {
    const pending = this.#pending.get(inviteKey(agent, channel));
    if (pending === undefined) return;
    pending.aborted = true;
    await pending.done;
  }

  /** Resolves when the start pipeline for the invite, if any, has settled. Never rejects. */
  handleInvite(e: HostEvents["irc.invite"]): Promise<void> {
    const d = this.#d;
    const profile = d.registry.lookup(e.target);
    if (profile === undefined) {
      d.logger.debug("invite ignored: target is not an Agent", { target: e.target });
      return Promise.resolve();
    }
    const nickKey = irc_lower(profile.nick);
    const own = this.#agents.get(nickKey);

    if (e.targetOnline && own === undefined) {
      // Req 3.12: the nick belongs to a non-Agent client.
      this.#noticeInviter(e.inviter, `${profile.nick} is unavailable: the nick is in use`);
      return Promise.resolve();
    }
    if (own !== undefined) {
      // D7: an online Agent never passed the resolver, so repeat its checks.
      if (d.bans.has(e.channel, profile.nick)) {
        this.#noticeInviter(e.inviter, `${profile.nick} is banned from ${e.channel}`);
        return Promise.resolve();
      }
      if (!d.inviters.allows(e.inviter)) {
        this.#noticeInviter(e.inviter, `you may not invite ${profile.nick}`);
        return Promise.resolve();
      }
    }

    const key = `${e.targetKey}\0${irc_lower(e.channel)}`;
    // Requirement 5.5: decided before the gate records the start, so a refusal leaves no state.
    const pendingChannels = [...this.#pending.keys()].map((k) => k.slice(k.indexOf("\0") + 1));
    const refusal = d.capacity?.(e.channel, pendingChannels);
    if (refusal !== undefined) {
      this.#noticeInviter(e.inviter, refusal);
      return Promise.resolve();
    }
    const decision = d.gate.decide(key, irc_lower(e.inviter), e.ts);
    if (decision.kind === "duplicate") return Promise.resolve();
    if (decision.kind === "rate-limited") {
      this.#noticeInviter(
        e.inviter,
        `invite rate limit of ${decision.limit} per minute reached; retry in ${decision.retryAfterSec} seconds`,
      );
      return Promise.resolve();
    }

    const pendingKey = inviteKey(profile.nick, e.channel);
    const pending: Pending = { aborted: false, done: Promise.resolve() };
    pending.done = this.#run(profile, e, key, () => pending.aborted).finally(() => {
      if (this.#pending.get(pendingKey) === pending) this.#pending.delete(pendingKey);
    });
    this.#pending.set(pendingKey, pending);
    return pending.done;
  }

  async #run(
    profile: AgentProfile,
    e: HostEvents["irc.invite"],
    key: string,
    isAborted: () => boolean,
  ): Promise<void> {
    const d = this.#d;
    const { channel } = e;
    let entry: AgentEntry | undefined;
    let joined = false;
    let harnessSession: HarnessSession | undefined;
    const check = (): void => {
      if (isAborted()) throw new AbortedError();
    };
    try {
      try {
        entry = await this.#agent(profile);
      } catch (err) {
        if (err instanceof NickInUseError) {
          this.#noticeInviter(e.inviter, `${profile.nick} is unavailable: the nick is in use`);
        }
        throw new StepError("register", err);
      }
      check();

      try {
        entry.client.dispatch({ command: "JOIN", params: [channel] });
        if (d.host.modeOf(channel, profile.nick) === undefined) {
          throw new Error("agent is not a member of the channel after JOIN");
        }
        joined = true; // no MODE is requested: the Agent keeps no mode (Req 3.5)
      } catch (err) {
        throw new StepError("join", err);
      }
      check();

      let info: WorktreeInfo;
      try {
        info = await d.worktrees.ensure(channel);
      } catch (err) {
        throw new StepError("worktree", err);
      }
      if (info.created) await this.#worktreeReady(channel);
      check();

      try {
        const output = entry.output;
        harnessSession = await this.#withTimeout(
          d.harness.openSession(profile, {
            cwd: info.realPath,
            onPermission: channelPermissionHandler(d, profile, channel, info.realPath, output),
          }),
          d.sessionOpenTimeoutMs ?? SESSION_OPEN_TIMEOUT_MS,
          "session/new timed out",
          (late) => {
            late.close().catch((err: unknown) => {
              d.logger.error("late session close failed", { reason: messageOf(err) });
            });
          },
        );
      } catch (err) {
        if (err instanceof AgentProfileNotLoadedError) {
          this.#noticeInviter(e.inviter, `agent profile ${profile.kiroAgent} not loaded`);
        }
        throw new StepError("session/new", err);
      }
      check();

      const previous = d.sessions.channelSession(profile.nick, channel);
      // Exorcism removes the closed Session, so remember that this pair had one (Req 3.7).
      const startedKey = inviteKey(profile.nick, channel);
      const resume =
        (previous !== undefined && previous.state === "closed") || this.#started.has(startedKey);
      this.#started.add(startedKey);
      const session = buildChannelSession(d, profile, channel, harnessSession, entry.output, d.isBlocked);
      d.onHarnessSession?.(session, harnessSession);
      d.sessions.addChannelSession(session);
      // public-hardening Requirement 4.1: the inviter may prompt this agent here without a mode.
      d.sessions.setInviter?.(profile.nick, channel, e.inviter);
      if (resume) {
        const built = buildResumePrompt({
          channel,
          topic: d.host.channel(channel)?.topic,
          lines: d.channelLog.lines(channel),
        });
        session.enqueue({ id: RESUME_ID_BASE - this.#resumeSeq++, text: built.text });
      }
      d.logger.info("agent joined channel", { agent: profile.nick, channel, resumed: resume });
    } catch (err) {
      await this.#fail(profile, e, key, entry, joined, harnessSession, err);
    }
  }

  async #fail(
    profile: AgentProfile,
    e: HostEvents["irc.invite"],
    key: string,
    entry: AgentEntry | undefined,
    joined: boolean,
    harnessSession: HarnessSession | undefined,
    err: unknown,
  ): Promise<void> {
    const d = this.#d;
    const { channel } = e;
    const aborted = err instanceof AbortedError;
    const step = err instanceof StepError ? err.step : "session/new";
    const cause = err instanceof StepError ? messageOf(err.cause) : messageOf(err);
    d.logger.error("invite pipeline failed", { agent: profile.nick, channel, step, cause });

    if (harnessSession !== undefined) {
      try {
        await harnessSession.close();
      } catch (closeErr) {
        d.logger.error("harness session close failed", { reason: messageOf(closeErr) });
      }
    }
    // Generic on purpose: only the step name is shown; the cause (paths, stderr, ...) were logged above and stay out of IRC.
    const text = `${profile.nick}: could not start in ${channel}: ${step} failed (see the runner log)`;
    const sandboxErr = err instanceof StepError && err.cause instanceof SandboxError ? err.cause : undefined;
    if (!aborted && sandboxErr !== undefined) {
      // agent-sandbox Requirement 11.1, 11.6: one ops notice with a fixed reason, and a log line.
      d.logger.error("sandbox start failed", { agent: profile.nick, channel, kind: sandboxErr.kind, cause: sandboxErr.message });
      this.#safe(() => {
        d.opNotice(channel, truncateBytes(sandboxNotice(profile.nick, channel, sandboxErr), 400));
      }, "opNotice");
    } else if (!aborted) {
      if (joined && entry !== undefined) {
        // The NOTICE goes first: after PART the Agent could no longer speak in +n channels.
        entry.output.channelNotice(channel, text);
      } else {
        this.#safe(() => {
          d.opNotice(channel, truncateBytes(text, 400));
        }, "opNotice");
      }
    }
    if (joined && entry !== undefined) {
      this.#safe(() => {
        entry.client.dispatch({ command: "PART", params: [channel] });
      }, "PART");
    }
    d.gate.release(key);
    try {
      await d.store.put({
        agent: irc_lower(profile.nick),
        channel: irc_lower(channel),
        acpSessionId: undefined,
        status: "closed",
        creditsUsed: d.ledger.amount(profile.nick, channel),
        updatedAt: d.clock.now(),
      });
    } catch (putErr) {
      d.logger.error("closed record could not be stored", { reason: messageOf(putErr) });
    }
    d.snapshot.setState(profile.nick, channel, "closed");
  }

  /** One virtual client per Agent; concurrent first calls share one creation. */
  #agent(profile: AgentProfile): Promise<AgentEntry> {
    const nickKey = irc_lower(profile.nick);
    const existing = this.#agents.get(nickKey);
    if (existing !== undefined) return Promise.resolve(existing);
    const inFlight = this.#creating.get(nickKey);
    if (inFlight !== undefined) return inFlight;
    const created = this.#createAgent(profile).then(
      (entry) => {
        this.#agents.set(nickKey, entry);
        this.#creating.delete(nickKey);
        return entry;
      },
      (err: unknown) => {
        this.#creating.delete(nickKey);
        throw err;
      },
    );
    this.#creating.set(nickKey, created);
    return created;
  }

  async #createAgent(profile: AgentProfile): Promise<AgentEntry> {
    const d = this.#d;
    const nickKey = irc_lower(profile.nick);
    // The ircd rejects USER names longer than 18 bytes or outside [A-Za-z0-9._~-], and a
    // rejected USER leaves registration hanging; a 30-char or `[`-containing nick must still work.
    const ircUser = nickKey.replace(/[^a-z0-9._~-]/g, "_").slice(0, MAX_USER_LENGTH);
    d.snapshot.register(profile.nick, {
      model: profile.model,
      tools: toolsLabel(profile.tools, d.sandboxMode),
      skills: profile.skills,
    });
    const client = d.host.createVirtualClient({
      id: `agent:${nickKey}`,
      // public-hardening Requirement 1.5: the agent's own client needs no PASS on a protected server.
      trusted: true,
      whoisExtra: () => renderWhois(d.snapshot.get(profile.nick), d.budgetLine?.()),
    });
    let off: Unsubscribe = () => undefined;
    const welcomed = new Promise<void>((resolve, reject) => {
      off = client.onMessage((msg: IrcMessage) => {
        if (msg.command === Numerics.RPL_WELCOME) resolve();
        else if (msg.command === Numerics.ERR_NICKNAMEINUSE) {
          reject(new NickInUseError(profile.nick));
        }
      });
    });
    welcomed.catch(() => undefined); // observed below; avoids an unhandled rejection on early failure
    try {
      client.dispatch({ command: "NICK", params: [profile.nick] });
      client.dispatch({
        command: "USER",
        params: [ircUser, "0", "*", `${profile.kiroAgent} (Séance agent)`],
      });
      await this.#withTimeout(
        welcomed,
        d.registerTimeoutMs ?? REGISTER_TIMEOUT_MS,
        "no 001 RPL_WELCOME within the registration timeout",
      );
    } catch (err) {
      off();
      this.#safe(() => {
        client.close("registration failed");
      }, "close");
      throw err;
    }
    off();
    const output = new AgentOutput({
      client,
      logger: d.logger,
      nick: profile.nick,
      user: ircUser,
      host: d.host.serverName,
      color: profile.color,
      snapshot: d.snapshot,
      ...(d.secrets !== undefined ? { secrets: d.secrets } : {}),
      ...(d.redactor !== undefined ? { redactor: d.redactor } : {}),
    });
    d.sessions.registerAgent({ profile, client, output });
    return { profile, client, output };
  }

  #withTimeout<T>(
    p: Promise<T>,
    ms: number,
    what: string,
    onLate?: (value: T) => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const handle = this.#d.timers.set(() => {
        settled = true;
        reject(new Error(what));
      }, ms);
      p.then(
        (value) => {
          if (settled) {
            onLate?.(value);
            return;
          }
          settled = true;
          this.#d.timers.clear(handle);
          resolve(value);
        },
        (err: unknown) => {
          if (settled) return;
          settled = true;
          this.#d.timers.clear(handle);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  /**
   * Req 5.1 to 5.5: one ChanServ line when this pipeline created the channel's worktree. No line
   * when the sha cannot be read (no placeholder); a failure never stops the pipeline.
   */
  async #worktreeReady(channel: string): Promise<void> {
    const d = this.#d;
    const services = d.services;
    if (services === undefined || d.worktrees.shortHead === undefined) return;
    try {
      const sha = await d.worktrees.shortHead(channel);
      if (sha === undefined) {
        d.logger.warn("worktree ready notice skipped: the short sha could not be read", { channel });
        return;
      }
      services.chanServ(channel, worktreeReady(worktreeNoticeDir(services.workspaces, channel), sha));
    } catch (err) {
      d.logger.error("worktree ready notice failed", { channel, reason: messageOf(err) });
    }
  }

  #noticeInviter(inviter: string, text: string): void {
    this.#safe(() => {
      this.#d.host.noticeTo(inviter, text);
    }, "noticeTo");
  }

  #safe(fn: () => void, what: string): void {
    try {
      fn();
    } catch (err) {
      this.#d.logger.error(`${what} failed`, { reason: messageOf(err) });
    }
  }
}
