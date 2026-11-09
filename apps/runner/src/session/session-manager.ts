import { irc_lower } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";

import type { Clock, TimerSet } from "../clock.js";
import { idleMinutes } from "../config.js";
import { createResetCreditsHandler, isResetCreditsCommand } from "../credits/reset-command.js";
import { CreditAccumulator } from "../credits/accumulator.js";
import type { CreditLedger } from "../credits/ledger.js";
import type { AgentHarness, HarnessSession } from "../harness/harness.js";
import type { RunnerLogger } from "../log.js";
import type { AgentOutput } from "../output/agent-output.js";
import { attachSessionOutput } from "../output/session-output.js";
import { handlePermissionRequest } from "../permissions/handler.js";
import { buildChannelPrompt, buildPrivatePrompt } from "../prompt/builder.js";
import type { ChannelLog } from "../prompt/channel-log.js";
import type { AgentProfile } from "../registry/agent-profile.js";
import type { AgentRegistry } from "../registry/agent-registry.js";
import type { HostEvents, HostVirtualClient, IrcHost, Unsubscribe } from "../ports.js";
import type { AllowList } from "../invite/allow-list.js";
import { SandboxError } from "../sandbox/errors.js";
import { WhoisSnapshot } from "../whois/snapshot.js";
import type { WorktreeManager } from "../worktree/worktree-manager.js";
import { AgentLoopGuard } from "./agent-loop-guard.js";
import { PendingPermissions } from "./pending-permissions.js";
import type { Prompt } from "./machine.js";
import { Session } from "./session.js";
import type { PromptGate, PromptSink } from "./session.js";

/** Invite_Key: `irc_lower(target) + "\0" + irc_lower(channel)` (Req 3.13). */
export function inviteKey(nick: string, channel: string): string {
  return `${irc_lower(nick)}\0${irc_lower(channel)}`;
}

const privateKey = (agent: string, human: string): string =>
  `${irc_lower(agent)}\0${irc_lower(human)}`;

/** Sender nick of a message prefix (`nick!user@host`), or undefined for a server prefix or none. */
function senderOf(prefix: string | undefined): string | undefined {
  if (prefix === undefined) return undefined;
  const bang = prefix.indexOf("!");
  return bang > 0 ? prefix.slice(0, bang) : undefined;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The Private_Session has no worktree and no config to guard. */
const OPEN_GATE: PromptGate = { check: () => Promise.resolve({ ok: true }) };

export type SessionManagerDeps = {
  readonly host: Pick<IrcHost, "modeOf" | "channel" | "noticeTo">;
  readonly registry: AgentRegistry;
  readonly harness: AgentHarness;
  readonly worktrees: Pick<WorktreeManager, "privateDir">;
  readonly channelLog: ChannelLog;
  readonly ledger: CreditLedger;
  readonly clock: Clock;
  readonly timers: TimerSet;
  readonly logger: RunnerLogger;
  /**
   * Respawns the Agent process if needed and opens a NEW Session for the
   * channel (`ensure` worktree, `openSession` with the permission handler, gate
   * and output wiring the InviteController uses). Used for revival after a
   * process exit (Req 9.15). Rejects when the Agent could not be started.
   * Without it, a prompt for a `closed` Session is dropped by that Session.
   */
  readonly reviveSession?: (reg: AgentRegistration, channel: string) => Promise<Session>;
  /** Who may start a Private_Session (the SEANCE_INVITERS gate); defaults to everyone. */
  readonly inviters?: AllowList;
  /** Agent-to-agent loop guard (runner-services Req 11); defaults to one with `AGENT_REPLY_LIMIT`. */
  readonly loopGuard?: AgentLoopGuard;
  /**
   * public-hardening Requirement 5: the daily credit cap or the kill switch refuses new turns,
   * also for Private_Sessions. Defaults to never blocked.
   */
  readonly globallyBlocked?: () => boolean;
  /**
   * public-hardening Requirement 12.3: a refusal text when no further agent session (one container
   * each in podman mode) may start; checked before a Private_Session opens. Absent means no cap.
   */
  readonly privateCapacity?: () => string | undefined;
  /**
   * agent-runner Requirement 9.18: seconds of inactivity after which a Private_Session is closed
   * and its human notified. Absent means no idle timeout.
   */
  readonly idleTimeoutS?: number;
};

/** At most this many Private_Sessions per human nick (across agents). */
export const MAX_PRIVATE_PER_HUMAN = 1;
/** At most this many Private_Sessions in total. */
export const MAX_PRIVATE_TOTAL = 4;

export type AgentRegistration = {
  readonly profile: AgentProfile;
  /** The Agent's own virtual client; private messages arrive on its listener. */
  readonly client: HostVirtualClient;
  readonly output: AgentOutput;
};

type PrivateEntry = {
  readonly session: Session;
  readonly harnessSession: HarnessSession;
  readonly agent: string;
  readonly detach: Unsubscribe;
};

/**
 * Owns Invite_Key → Session and (agent, human nick) → Private_Session, and
 * routes chat to prompts (Requirement 5). A prompt reaches an Agent only
 * through its Session; nothing here ever dispatches an IRC command.
 */
export class SessionManager {
  readonly #d: SessionManagerDeps;
  readonly #channelSessions = new Map<string, Session>();
  readonly #agents = new Map<string, AgentRegistration>();
  readonly #listeners = new Map<string, Unsubscribe>();
  readonly #privates = new Map<string, Promise<PrivateEntry | undefined>>();
  /** Opened Private_Sessions, so the daily cap can cancel a running private turn (Requirement 12.2). */
  readonly #openPrivates = new Set<Session>();
  readonly #resetCredits: (sender: string, agent: string) => unknown;
  readonly #reviving = new Map<string, Promise<Session | undefined>>();
  /** runner-services Requirement 11: Agent lines reach other Agents only when bounded. */
  readonly #loopGuard: AgentLoopGuard;
  #nextPromptId = 1;
  /** Invite_Key -> nick that invited the agent into the channel (public-hardening Requirement 4.1). */
  readonly #inviters = new Map<string, string>();

  constructor(deps: SessionManagerDeps) {
    this.#d = deps;
    this.#loopGuard = deps.loopGuard ?? new AgentLoopGuard();
    this.#resetCredits = createResetCreditsHandler({
      ledger: deps.ledger,
      modeOf: (channel, nick) => deps.host.modeOf(channel, nick),
      noticeTo: (nick, text) => deps.host.noticeTo(nick, text),
      isAgentNick: (nick) => deps.registry.lookup(nick) !== undefined,
      ...(deps.inviters !== undefined ? { isInviter: (nick: string) => deps.inviters?.allows(nick) === true } : {}),
      logger: deps.logger,
    });
  }

  /** Subscribes to harness process events so an exit closes the Agent's Sessions (Req 9.14). */
  attach(): Unsubscribe {
    return this.#d.harness.onProcessEvent((e) => {
      if (e.kind === "exited") this.onProcessExited(e.agent, e.sessionIds);
    });
  }

  /**
   * Moves every Session of the exited process to `closed` (queued prompts are
   * reported dropped by the Session) and forgets its Private_Sessions. The
   * Agents stay in their channels (Req 9.14).
   */
  onProcessExited(agent: string, sessionIds?: readonly string[]): void {
    // agent-sandbox Requirement 8.3: a container serves one session, so only those close.
    const only = sessionIds === undefined ? undefined : new Set(sessionIds);
    for (const session of this.sessionsOfAgent(agent)) {
      if (session.state === "closed") continue;
      if (only !== undefined && !only.has(session.acpSessionId)) continue;
      try {
        session.close("process-exit");
      } catch (err) {
        this.#d.logger.error("session close after process exit failed", {
          agent,
          channel: session.channel,
          reason: messageOf(err),
        });
      }
      this.#forgetIfNoOpenSession(session.channel);
    }
    this.closePrivateSessions("process-exit", agent, only).catch((err: unknown) => {
      this.#d.logger.error("private session close after process exit failed", {
        agent,
        reason: messageOf(err),
      });
    });
  }

  /**
   * Replaces a `closed` Session with a new one (Req 9.15). Single-flight per
   * Invite_Key. On failure the Agent stays in the channel, a channel NOTICE
   * says it could not be started and `undefined` is returned (Req 9.16).
   */
  #revive(closed: Session): Promise<Session | undefined> {
    const key = inviteKey(closed.agent, closed.channel);
    const inFlight = this.#reviving.get(key);
    if (inFlight !== undefined) return inFlight;
    const reg = this.#agents.get(irc_lower(closed.agent));
    const factory = this.#d.reviveSession;
    if (reg === undefined || factory === undefined) return Promise.resolve(undefined);

    const attempt = (async (): Promise<Session | undefined> => {
      try {
        const fresh = await factory(reg, closed.channel);
        this.addChannelSession(fresh);
        this.#d.logger.info("session revived after process exit", {
          agent: closed.agent,
          channel: closed.channel,
        });
        return fresh;
      } catch (err) {
        this.#d.logger.error("session revival failed", {
          agent: closed.agent,
          channel: closed.channel,
          reason: messageOf(err),
        });
        try {
          // agent-sandbox Requirement 11.1: a sandbox failure already sent its one ops notice.
          if (!(err instanceof SandboxError)) {
            reg.output.channelNotice(closed.channel, `${closed.agent}: could not be started`);
          }
        } catch (noticeErr) {
          this.#d.logger.error("revival failure notice failed", { reason: messageOf(noticeErr) });
        }
        return undefined;
      } finally {
        this.#reviving.delete(key);
      }
    })();
    this.#reviving.set(key, attempt);
    return attempt;
  }

  // ---- channel Sessions (by Invite_Key) -------------------------------------------------

  /** Registers a channel Session. Throws when a Session that is not `closed` already holds the key. */
  addChannelSession(session: Session): void {
    const key = inviteKey(session.agent, session.channel);
    const existing = this.#channelSessions.get(key);
    if (existing !== undefined && existing !== session && existing.state !== "closed") {
      throw new Error(
        `A Session for ${session.agent} in ${session.channel} already exists in state ${existing.state}`,
      );
    }
    this.#channelSessions.set(key, session);
  }

  /** Remembers who invited `agent` into `channel`; that nick may prompt it without a mode. */
  setInviter(agent: string, channel: string, inviter: string): void {
    this.#inviters.set(inviteKey(agent, channel), inviter);
  }

  removeChannelSession(agent: string, channel: string): void {
    this.#channelSessions.delete(inviteKey(agent, channel));
    this.#inviters.delete(inviteKey(agent, channel));
    this.#forgetIfNoOpenSession(channel);
  }

  /** runner-services Req 11.5: no open Session left in the channel, so its loop counts go. */
  #forgetIfNoOpenSession(channel: string): void {
    if (this.sessionsOf(channel).every((s) => s.state === "closed")) this.#loopGuard.forgetChannel(channel);
  }

  channelSession(agent: string, channel: string): Session | undefined {
    return this.#channelSessions.get(inviteKey(agent, channel));
  }

  /** All channel Sessions of `channel` (any agent, any state). */
  sessionsOf(channel: string): readonly Session[] {
    const c = irc_lower(channel);
    return [...this.#channelSessions.values()].filter((s) => irc_lower(s.channel) === c);
  }

  /** Every channel Session (any channel, any state); the daily cap cancels the prompting ones. */
  allChannelSessions(): readonly Session[] {
    return [...this.#channelSessions.values()];
  }

  /**
   * Every Session that may be prompting: channel Sessions and opened Private_Sessions. The daily
   * cap cancels the prompting ones (public-hardening Requirement 12.2).
   */
  allSessions(): readonly Session[] {
    for (const s of this.#openPrivates) if (s.state === "closed") this.#openPrivates.delete(s);
    return [...this.#channelSessions.values(), ...this.#openPrivates];
  }

  /**
   * Private_Sessions that are open or still starting (each is a container in podman mode). A
   * closed one is removed from the map when it closes, so it never counts.
   */
  privateCount(): number {
    return this.#privates.size;
  }

  /** All channel Sessions of `agent` (any channel, any state). */
  sessionsOfAgent(agent: string): readonly Session[] {
    const a = irc_lower(agent);
    return [...this.#channelSessions.values()].filter((s) => irc_lower(s.agent) === a);
  }

  // ---- agents and private messages -------------------------------------------------------

  /** Listens on the Agent's own virtual client for private messages. */
  registerAgent(reg: AgentRegistration): Unsubscribe {
    const nick = irc_lower(reg.profile.nick);
    this.#listeners.get(nick)?.();
    this.#agents.set(nick, reg);
    const off = reg.client.onMessage((msg) => {
      this.#onAgentClientMessage(reg, msg);
    });
    this.#listeners.set(nick, off);
    return () => {
      off();
      if (this.#listeners.get(nick) === off) {
        this.#listeners.delete(nick);
        this.#agents.delete(nick);
      }
    };
  }

  /** Closes every Private_Session (of one Agent, or all) and forgets its harness session. */
  async closePrivateSessions(
    reason: "process-exit" | "shutdown",
    agent?: string,
    /** Podman mode: only the private sessions with these ACP session ids (one container). */
    sessionIds?: ReadonlySet<string>,
  ): Promise<void> {
    const a = agent === undefined ? undefined : irc_lower(agent);
    // Requirement 11.5: the loop guard's counts are forgotten when the runner shuts down.
    if (reason === "shutdown" && a === undefined) this.#loopGuard.clear();
    const closing: Promise<void>[] = [];
    for (const [key, pending] of [...this.#privates]) {
      if (a !== undefined && !key.startsWith(`${a}\0`)) continue;
      if (sessionIds !== undefined) {
        // Decide after the entry resolved: a private session of another container stays open.
        closing.push(
          pending.then(async (entry) => {
            if (entry === undefined || !sessionIds.has(entry.harnessSession.id)) return;
            if (this.#privates.get(key) === pending) this.#privates.delete(key);
            entry.detach();
            entry.session.close(reason);
            await entry.harnessSession.close().catch((err: unknown) => {
              this.#d.logger.error("private session close failed", { agent: entry.agent, reason: messageOf(err) });
            });
          }),
        );
        continue;
      }
      this.#privates.delete(key);
      closing.push(
        pending.then(async (entry) => {
          if (entry === undefined) return;
          entry.detach();
          entry.session.close(reason);
          try {
            await entry.harnessSession.close();
          } catch (err) {
            this.#d.logger.error("private session close failed", {
              agent: entry.agent,
              reason: messageOf(err),
            });
          }
        }),
      );
    }
    await Promise.all(closing);
  }

  // ---- routing ---------------------------------------------------------------------------

  /** Handler for the `irc.message` host event (Req 5.1, 5.7, 5.8, 5.14). */
  onChannelMessage(e: HostEvents["irc.message"]): void {
    const { channel, from, message } = e;
    if (message.command !== "PRIVMSG") {
      this.#ignored("channel message", `command ${message.command} is not PRIVMSG`, { channel, from });
      return;
    }
    const text = message.params[1];
    if (typeof text !== "string") {
      this.#ignored("channel message", "PRIVMSG has no text parameter", { channel, from });
      return;
    }
    this.#d.channelLog.add(channel, { nick: from, text, ts: this.#d.clock.now() });

    const sender = this.#d.host.modeOf(channel, from);
    const senderIsAgent = this.#d.registry.lookup(from) !== undefined;
    // runner-services Req 11.4: only a member with +v or +o who is not a Known_Agent resets the
    // channel's counts, and it does so before anything else (also when no Session is open yet).
    // Unmoded nicks and agents never reset.
    const resets = !senderIsAgent && sender !== undefined && (sender.op || sender.voice);
    if (resets) this.#loopGuard.humanSpoke(channel);

    const sessions = this.sessionsOf(channel);
    if (sessions.length === 0) {
      this.#ignored("channel message", "no Session in the channel", { channel, from });
      return;
    }

    const built = buildChannelPrompt({
      channel,
      nick: from,
      senderIsOp: sender?.op === true,
      senderIsHumanOp: !senderIsAgent && sender?.op === true,
      text,
    });
    const moderated = this.#d.host.channel(channel)?.modes.moderated === true;
    const fromKey = irc_lower(from);

    const senderHasMode = sender !== undefined && (sender.op || sender.voice);
    for (const session of sessions) {
      if (irc_lower(session.agent) === fromKey) continue; // never prompt the sender
      // public-hardening Requirement 4.1: only +v/+o senders, or the nick that invited this agent here,
      // start a turn. The line is already in the channel log, so it still informs later prompts.
      const invitedBy = this.#inviters.get(inviteKey(session.agent, channel));
      if (!senderHasMode && (invitedBy === undefined || irc_lower(invitedBy) !== fromKey)) {
        this.#d.logger.debug("no prompt: sender has no mode and is not the inviter", {
          agent: session.agent,
          channel,
          from,
        });
        continue;
      }
      const mode = this.#d.host.modeOf(channel, session.agent); // read now, never cached
      const hasMode = mode !== undefined && (mode.op || mode.voice);
      // No mode: listen only (Req 5.8). Under +m only +v/+o may act (Req 5.7).
      const canSpeak = hasMode && (!moderated || mode.op || mode.voice);
      if (!canSpeak) {
        this.#d.logger.debug("no prompt: agent has no mode", {
          agent: session.agent,
          channel,
          moderated,
        });
        continue;
      }
      // runner-services Req 11.1, 11.3, 11.6: decided before a prompt id, a revival or a process.
      if (senderIsAgent && !this.#agentLineAllowed(channel, from, session.agent, text)) continue;
      const prompt = this.#prompt(built.text);
      if (session.state === "closed" && this.#canRevive(session)) {
        // The Session keeps rejecting (Req 6.12); a new one takes the prompt (Req 9.15).
        void this.#revive(session).then((fresh) => {
          if (fresh !== undefined) fresh.enqueue(prompt);
          else {
            // Req 11.3: an agent prompt counts only when the revival succeeded. The count was taken
            // at decision time (so concurrent lines cannot overshoot the limit) and is given back here.
            if (senderIsAgent) this.#loopGuard.release(channel, session.agent);
            this.#d.logger.warn("prompt dropped: agent could not be started", {
              agent: session.agent,
              channel,
              id: prompt.id,
            });
          }
        });
        continue;
      }
      session.enqueue(prompt);
    }
  }

  /** Loop guard for an Agent's line offered to another Agent; logs every drop (once per limit episode). */
  #agentLineAllowed(channel: string, from: string, recipient: string, text: string): boolean {
    const decision = this.#loopGuard.decide(channel, recipient, text);
    if (decision === "deliver") return true;
    if (decision === "not-mentioned") {
      this.#d.logger.debug("no prompt: agent line does not mention the agent", { agent: recipient, from, channel });
    } else if (this.#loopGuard.firstLimitHit(channel, recipient)) {
      this.#d.logger.info("agent reply limit reached", {
        agent: recipient,
        from,
        channel,
        limit: this.#loopGuard.limit,
      });
    }
    return false;
  }

  /** A closed Session is revived only while the Agent is still a member and can be respawned. */
  #canRevive(session: Session): boolean {
    return (
      this.#d.reviveSession !== undefined &&
      this.#agents.has(irc_lower(session.agent)) &&
      this.#d.host.modeOf(session.channel, session.agent) !== undefined
    );
  }

  #onAgentClientMessage(reg: AgentRegistration, msg: IrcMessage): void {
    if (msg.command !== "PRIVMSG" && msg.command !== "NOTICE") return;
    const target = msg.params[0];
    if (target === undefined || irc_lower(target) !== irc_lower(reg.profile.nick)) {
      return; // a channel message: handled through onChannelMessage
    }
    const sender = senderOf(msg.prefix);
    if (msg.command === "NOTICE") {
      this.#ignored("private message", "NOTICE is never a prompt", {
        agent: reg.profile.nick,
        ...(sender !== undefined ? { from: sender } : {}),
      });
      return;
    }
    if (sender === undefined) {
      this.#ignored("private message", "sender has no nick prefix", { agent: reg.profile.nick });
      return;
    }
    const text = msg.params[1];
    if (typeof text !== "string") {
      this.#ignored("private message", "PRIVMSG has no text parameter", {
        agent: reg.profile.nick,
        from: sender,
      });
      return;
    }

    // Req 10.14: intercepted before any prompt is built; never reaches a Session.
    if (isResetCreditsCommand(text)) {
      this.#resetCredits(sender, reg.profile.nick);
      return;
    }
    if (this.#d.registry.lookup(sender) !== undefined) {
      this.#ignored("private message", "sender is an Agent", {
        agent: reg.profile.nick,
        from: sender,
      });
      return;
    }

    if (this.#d.inviters !== undefined && !this.#d.inviters.allows(sender)) {
      this.#refusePrivate(sender, reg.profile.nick, "you may not start a private session");
      return;
    }

    const built = buildPrivatePrompt({
      nick: sender,
      senderIsHumanOp: this.#isHumanOpFor(reg.profile.nick, sender),
      text,
    });
    const prompt = this.#prompt(built.text);
    void this.#privateSession(reg, sender).then((entry) => {
      entry?.session.enqueue(prompt);
    });
  }

  /**
   * Human_Op for a private message: `+o` in at least one channel where the
   * Agent has a Session that is not `closed`, and not an Agent nick.
   */
  #isHumanOpFor(agent: string, sender: string): boolean {
    if (this.#d.registry.lookup(sender) !== undefined) return false;
    return this.sessionsOfAgent(agent).some(
      (s) => s.state !== "closed" && this.#d.host.modeOf(s.channel, sender)?.op === true,
    );
  }

  #privateSession(reg: AgentRegistration, human: string): Promise<PrivateEntry | undefined> {
    const key = privateKey(reg.profile.nick, human);
    const existing = this.#privates.get(key);
    if (existing !== undefined) {
      return existing.then((entry) => {
        if (entry !== undefined && entry.session.state === "closed") {
          if (this.#privates.get(key) === existing) this.#privates.delete(key);
          return this.#privateSession(reg, human);
        }
        return entry;
      });
    }
    const humanKey = irc_lower(human);
    const keys = [...this.#privates.keys()];
    const ofHuman = keys.filter((k) => k.slice(k.indexOf("\0") + 1) === humanKey).length;
    if (ofHuman >= MAX_PRIVATE_PER_HUMAN) {
      this.#refusePrivate(human, reg.profile.nick, "you already have a private session");
      return Promise.resolve(undefined);
    }
    if (keys.length >= MAX_PRIVATE_TOTAL) {
      this.#refusePrivate(human, reg.profile.nick, "too many private sessions are open");
      return Promise.resolve(undefined);
    }
    // public-hardening Requirement 12.3: a private session is a container too.
    const full = this.#d.privateCapacity?.();
    if (full !== undefined) {
      this.#refusePrivate(human, reg.profile.nick, full);
      return Promise.resolve(undefined);
    }
    const created = this.#openPrivate(reg, human).then((entry) => {
      if (entry === undefined) {
        if (this.#privates.get(key) === created) this.#privates.delete(key);
        return entry;
      }
      // public-hardening re-check: a Private_Session leaves the count the moment it closes,
      // whatever closed it (process exit, shutdown, a failed turn), not at the next message.
      const forget = (): void => {
        this.#openPrivates.delete(entry.session);
        if (this.#privates.get(key) === created) this.#privates.delete(key);
      };
      if (entry.session.state === "closed") forget();
      else {
        const off = entry.session.stateChanges((state) => {
          if (state !== "closed") return;
          off();
          forget();
        });
      }
      return entry;
    });
    this.#privates.set(key, created);
    return created;
  }

  async #openPrivate(reg: AgentRegistration, human: string): Promise<PrivateEntry | undefined> {
    const { profile } = reg;
    const logger = this.#d.logger;
    const idleTimeoutS = this.#d.idleTimeoutS;
    // Set once the entry exists; `onIdle` only runs from a timer, after that.
    let opened: PrivateEntry | undefined;
    try {
      const cwd = await this.#d.worktrees.privateDir(profile.nick);
      const permissions = new PendingPermissions();
      const harnessSession = await this.#d.harness.openSession(profile, {
        cwd,
        onPermission: async (req) => {
          const end = permissions.begin();
          try {
            return await handlePermissionRequest(
              {
                agent: profile.nick,
                worktree: cwd,
                isPrivate: true, // voice-level reads only; write and shell are rejected
                currentMembership: () => undefined,
                logger,
              },
              req,
            );
          } finally {
            end();
          }
        },
      });
      const sink: PromptSink = {
        dropped: (prompt, why) => {
          logger.warn("private prompt dropped", { agent: profile.nick, human, id: prompt.id, why });
        },
      };
      const session = new Session({
        agent: profile.nick,
        channel: human, // output target; a Private_Session is addressed to the human nick
        harnessSession,
        snapshot: new WhoisSnapshot(), // isolated: a private session is not a channel in WHOIS
        timers: this.#d.timers,
        gate: OPEN_GATE,
        sink,
        opNotice: (_channel, text) => {
          logger.info("private session notice", { agent: profile.nick, human, text });
        },
        // Private_Sessions ignore the channel cap, but not the daily cap or the kill switch.
        isBlocked: () => this.#d.globallyBlocked?.() === true,
        logger,
        // agent-runner Requirement 9.18: an abandoned /query releases its container too.
        ...(idleTimeoutS !== undefined
          ? {
              idle: {
                timeoutS: idleTimeoutS,
                permissions,
                onIdle: () => {
                  if (opened !== undefined) void this.#releaseIdlePrivate(opened, human, idleTimeoutS);
                },
              },
            }
          : {}),
      });
      const detach = attachSessionOutput({ session, output: reg.output, clock: this.#d.clock });
      // public-hardening Requirement 12.1: /query spend counts towards SEANCE_DAILY_CREDIT_CAP.
      const acc = new CreditAccumulator(`${profile.nick}@private:${human}:${harnessSession.id}`, logger);
      session.sessionEvents((ev) => {
        if (ev.kind === "metadata") this.#d.ledger.recordPrivateMetering(acc, ev.metering);
      });
      this.#openPrivates.add(session);
      opened = { session, harnessSession, agent: profile.nick, detach };
      return opened;
    } catch (err) {
      logger.error("private session could not be opened", {
        agent: profile.nick,
        human,
        reason: messageOf(err),
      });
      try {
        this.#d.host.noticeTo(human, `${profile.nick}: could not start a private session`);
      } catch (noticeErr) {
        logger.error("private session failure notice failed", { reason: messageOf(noticeErr) });
      }
      return undefined;
    }
  }

  /**
   * Idle timeout of a Private_Session: tells the human once, then closes it like a QUIT does
   * (detach the output, close the Session, close the harness session, which removes the container
   * in podman mode). No worktree reset and no PART: there is no channel. The `closed` state change
   * removes the entry, so the next private message opens a fresh session.
   */
  async #releaseIdlePrivate(entry: PrivateEntry, human: string, idleTimeoutS: number): Promise<void> {
    if (entry.session.state === "closed") return;
    try {
      this.#d.host.noticeTo(human, `${entry.agent} idle for ${idleMinutes(idleTimeoutS)} min, releasing the session`);
    } catch (err) {
      this.#d.logger.error("private session idle notice failed", { agent: entry.agent, human, reason: messageOf(err) });
    }
    entry.detach();
    entry.session.close("idle");
    try {
      await entry.harnessSession.close();
    } catch (err) {
      this.#d.logger.error("private session close failed", { agent: entry.agent, reason: messageOf(err) });
    }
  }

  #refusePrivate(human: string, agent: string, why: string): void {
    this.#d.logger.warn("private session refused", { agent, human, why });
    try {
      this.#d.host.noticeTo(human, `${agent}: ${why}`);
    } catch (err) {
      this.#d.logger.error("private session refusal notice failed", { reason: messageOf(err) });
    }
  }

  #prompt(text: string): Prompt {
    return { id: this.#nextPromptId++, text };
  }

  #ignored(event: string, reason: string, fields: Readonly<Record<string, unknown>>): void {
    this.#d.logger.info("event ignored", { event, reason, ...fields });
  }
}
