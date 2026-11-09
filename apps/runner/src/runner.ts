import { existsSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { join } from "node:path";
import { irc_lower } from "@seance/irc-protocol";
import { realClock, TimerSet } from "./clock.js";
import type { Clock } from "./clock.js";
import {
  assertInvitersConfigured,
  ConfigError,
  DEFAULT_IDLE_TIMEOUT_S,
  HARDENING_DEFAULTS,
  idleMinutes,
  validateRunnerPaths,
} from "./config.js";
import type { RunnerConfig } from "./config.js";
import { DailyBudget } from "./credits/budget.js";
import { CreditsFile } from "./credits/credits-file.js";
import { CreditLedger } from "./credits/ledger.js";
import { SecretRedactor } from "./output/secret-redactor.js";
import { readAuthSecrets } from "./sandbox/auth-secrets.js";
import { DEFAULT_GIT_TIMEOUT_MS } from "./worktree/git.js";
import { createExorcist } from "./exorcism/exorcism.js";
import { createExorcismTriggers } from "./exorcism/triggers.js";
import { AcpHarness } from "./harness/acp-harness.js";
import type { AgentHarness, HarnessSession } from "./harness/harness.js";
import { HeadlessHarness } from "./harness/headless-harness.js";
import { parseInviters } from "./invite/allow-list.js";
import { BanList } from "./invite/ban-list.js";
import { buildChannelSession, channelPermissionHandler } from "./invite/channel-session.js";
import type { ChannelSessionDeps } from "./invite/channel-session.js";
import { InviteController } from "./invite/invite-controller.js";
import { InviteGate } from "./invite/invite-gate.js";
import { createInviteResolver } from "./invite/resolver.js";
import type { InviteResolver } from "./invite/resolver.js";
import type { RunnerLogger } from "./log.js";
import { opNotice } from "./output/agent-output.js";
import type { AgentOutput } from "./output/agent-output.js";
import type { IrcHost, Unsubscribe } from "./ports.js";
import { ChannelLog } from "./prompt/channel-log.js";
import { AgentRegistry } from "./registry/agent-registry.js";
import { verifyAgentFiles } from "./registry/verify-agent-files.js";
import { installHungHandler } from "./session/hung-handler.js";
import { MemorySessionStore } from "./session/memory-session-store.js";
import { PendingPermissions } from "./session/pending-permissions.js";
import { SessionManager } from "./session/session-manager.js";
import type { AgentRegistration } from "./session/session-manager.js";
import type { Session } from "./session/session.js";
import type { SessionStore } from "./session/session-store.js";
import { createShutdown } from "./shutdown.js";
import type { ShutdownReport } from "./shutdown.js";
import { agentsOnline } from "./services/notices.js";
import { createServices } from "./services/services.js";
import { agentStatus } from "./whois/render.js";
import { WhoisSnapshot } from "./whois/snapshot.js";
import { SandboxError } from "./sandbox/errors.js";
import { assertSandboxForPublic } from "./sandbox/guard.js";
import { PodmanLauncher, type PodmanExec } from "./sandbox/launcher.js";
import { sandboxNotice } from "./sandbox/notices.js";
import { createGitRunner } from "./worktree/git.js";
import { createTurnCommitter } from "./worktree/turn-committer.js";
import { WorktreeManager } from "./worktree/worktree-manager.js";

export type RunnerOptions = {
  readonly host: IrcHost;
  readonly config: RunnerConfig;
  readonly logger: RunnerLogger;
  readonly clock?: Clock;
  /** Overrides the harness chosen by `config.harness` (tests). */
  readonly harness?: AgentHarness;
  /**
   * Defaults to the credits file `<SEANCE_WORKSPACES>/.seance-credits.json` (public-hardening
   * Requirement 5.1), so totals and the daily budget survive a restart.
   */
  readonly store?: SessionStore;
  /**
   * Address the ircd listens on (`IRCD_HOST`). Without SEANCE_INVITERS, startup fails unless this is
   * a loopback address; unset means all interfaces.
   */
  readonly bindHost?: string;
  /** Extra environment for agent processes beyond the allow-list; read at each spawn (tests only). */
  readonly childEnv?: () => Readonly<Record<string, string | undefined>>;
  /**
   * IRCD_PUBLIC=1 (agent-sandbox Requirement 2.5): `start()` refuses to run without the podman
   * sandbox. Default false.
   */
  readonly publicDeployment?: boolean;
  /**
   * `IRCD_TRUSTED_PROXIES` of the ircd (public-hardening Requirement 11.2): with
   * `publicDeployment`, `start()` refuses unless it is non-empty and loopback only.
   */
  readonly trustedProxies?: readonly string[];
  /** Podman command runner for the sandbox launcher (tests: the fake podman). */
  readonly podmanExec?: PodmanExec;
  /** Environment the podman process is built from; defaults to `process.env` (tests). */
  readonly podmanBaseEnv?: Readonly<Record<string, string | undefined>>;
};

export interface Runner {
  /**
   * Validates paths, loads the registry, checks the agent files, picks the
   * harness and wires every host subscription. No invite is accepted before
   * it resolves. Rejects (and spawns nothing) on any startup failure.
   */
  start(): Promise<void>;
  /** Synchronous resolver for the ircd: claims agent nicks only while running. */
  readonly inviteResolver: InviteResolver;
  /** Adds a runner-level ban; does not exorcise (design D3). */
  ban(channel: string, nick: string): void;
  unban(channel: string, nick: string): boolean;
  /** Idempotent graceful shutdown (Req 11). */
  shutdown(): Promise<ShutdownReport>;
  /**
   * public-hardening Requirement 2.3: the registry's agent nicks, which humans may not take.
   * Empty before `start()` resolves.
   */
  agentNicks(): readonly string[];
}

const SETTLE_POLL_MS = 25;
const SETTLE_MAX_MS = 30_000;

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const EMPTY_REPORT: ShutdownReport = { errors: [], remainingTimers: 0, remainingProcesses: 0 };

/** Everything built by `start()`. */
type Parts = {
  readonly resolver: InviteResolver;
  readonly shutdown: ReturnType<typeof createShutdown>;
  readonly agentNicks: readonly string[];
};

/** 127.0.0.0/8 and ::1, plus their IPv4-mapped IPv6 form (::ffff:127.0.0.0/104). */
const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");
LOOPBACK.addSubnet("::ffff:7f00:0", 104, "ipv6");

/**
 * True for a loopback IP literal in any spelling (`::1`, `0:0:0:0:0:0:0:1`, `::ffff:127.0.0.1`).
 * Host names are not IP literals. Same rule as the ircd's `isLoopbackIp` (client-ip.ts).
 */
export function isLoopbackIpLiteral(entry: string): boolean {
  const ip = entry.trim().toLowerCase();
  const family = isIP(ip);
  if (family === 0) return false;
  return LOOPBACK.check(ip, family === 4 ? "ipv4" : "ipv6");
}

/**
 * public-hardening Requirement 8: with IRCD_PUBLIC=1 the runner also refuses to start without
 * SEANCE_INVITERS and SEANCE_DAILY_CREDIT_CAP (the ircd's guard names them first; this repeats it
 * for embedders).
 */
export function assertPublicRunner(
  config: RunnerConfig,
  publicDeployment: boolean,
  trustedProxies?: readonly string[],
): void {
  if (!publicDeployment) return;
  // Requirement 11.2: behind the proxy every peer is loopback; without the proxy list all users
  // would share one per-IP limit and one PASS-failure block.
  const proxies = trustedProxies ?? [];
  if (proxies.length === 0 || !proxies.every(isLoopbackIpLiteral)) {
    throw new ConfigError(
      "IRCD_TRUSTED_PROXIES",
      "IRCD_PUBLIC=1 requires IRCD_TRUSTED_PROXIES listing the proxy's loopback addresses only (e.g. 127.0.0.1,::1)",
    );
  }
  if (config.inviters === undefined || config.inviters.length === 0) {
    throw new ConfigError("SEANCE_INVITERS", "IRCD_PUBLIC=1 requires SEANCE_INVITERS (the account nicks that may invite agents)");
  }
  if (config.dailyCreditCap === undefined) {
    throw new ConfigError("SEANCE_DAILY_CREDIT_CAP", "IRCD_PUBLIC=1 requires SEANCE_DAILY_CREDIT_CAP (credits per UTC day for all agents)");
  }
}

export function createRunner(opts: RunnerOptions): Runner {
  const { host, logger } = opts;
  const clock = opts.clock ?? realClock;
  const bans = new BanList();
  let shuttingDown = false;
  let started = false;
  let starting: Promise<void> | undefined;
  let parts: Parts | undefined;

  const inviteResolver: InviteResolver = (target, channel, inviter) =>
    started && !shuttingDown && parts !== undefined && parts.resolver(target, channel, inviter);

  async function setup(): Promise<Parts> {
    // 1-3. Fail closed before anything is spawned.
    // agent-sandbox Requirement 2.5: repeated here so an embedder cannot skip the ircd's check.
    assertSandboxForPublic({
      public: opts.publicDeployment === true,
      runnerEnabled: true,
      sandbox: opts.config.sandbox.mode,
      blockedCidrs: opts.config.sandbox.mode === "podman" ? opts.config.sandbox.blockedCidrs.length : 0,
    });
    assertInvitersConfigured(opts.config, opts.bindHost);
    assertPublicRunner(opts.config, opts.publicDeployment === true, opts.trustedProxies);
    // public-hardening Requirement 3.3: with accounts, every SEANCE_INVITERS entry is an account,
    // otherwise nobody listed could ever invite (a misconfiguration, not a quiet lockout).
    if (host.accountsEnabled === true) {
      const missing = (opts.config.inviters ?? []).filter((n) => host.isAccount?.(n) !== true);
      if (missing.length > 0) {
        throw new ConfigError(
          "SEANCE_INVITERS",
          `SEANCE_INVITERS names nicks without an account in IRCD_ACCOUNTS_FILE: ${missing.join(", ")}`,
        );
      }
    }
    const config = await validateRunnerPaths(opts.config);
    const sandboxConfig = config.sandbox;
    const podman = sandboxConfig.mode === "podman";
    const registry = await AgentRegistry.load(config.agentsDir, logger, { sandboxed: podman });
    await verifyAgentFiles(registry, config.agentsDir);

    // agent-sandbox Requirement 3.1: the Preflight and a sweep run before any invite is accepted.
    let launcher: PodmanLauncher | undefined;
    if (sandboxConfig.mode === "podman") {
      for (const name of sandboxConfig.ignored) {
        logger.warn(
          name === "KIRO_API_KEY"
            ? "KIRO_API_KEY is set but never forwarded to the sandbox; the credential is SEANCE_SANDBOX_AUTH_DIR"
            : "SEANCE_KIRO_BIN is ignored in podman mode; the command inside the image is SEANCE_SANDBOX_KIRO_BIN",
          { variable: name },
        );
      }
      launcher = new PodmanLauncher({
        config: sandboxConfig,
        agentsDir: config.agentsDir,
        worktreeRoot: config.workspaces,
        targetRepo: config.targetRepo,
        logger,
        ...(opts.podmanExec !== undefined ? { exec: opts.podmanExec } : {}),
        ...(opts.podmanBaseEnv !== undefined ? { baseEnv: opts.podmanBaseEnv } : {}),
      });
      await launcher.preflight();
      const swept = await launcher.sweep();
      if (swept > 0) logger.info("sandbox containers from an earlier run removed", { count: swept });
    }

    // 4. Harness choice: acp for unset/empty/"acp", headless for "headless".
    const baseHarness: AgentHarness =
      opts.harness ??
      (config.harness === "headless"
        ? new HeadlessHarness(config)
        : new AcpHarness({
            config,
            logger,
            clock,
            promptTimeoutMs: config.promptTimeoutMs,
            ...(opts.childEnv !== undefined ? { extraEnv: opts.childEnv } : {}),
            ...(launcher !== undefined ? { sandbox: launcher } : {}),
          }));
    // Refuses to open sessions once shutdown began (covers invites, revival and private chats).
    const harness: AgentHarness = {
      openSession: (profile, o) =>
        shuttingDown
          ? Promise.reject(new Error("runner is shutting down"))
          : baseHarness.openSession(profile, o),
      terminate: (profile, signal) => baseHarness.terminate(profile, signal),
      onProcessEvent: (l) => baseHarness.onProcessEvent(l),
      hasProcess: (profile) => baseHarness.hasProcess(profile),
      dispose: () => baseHarness.dispose(),
    };

    const timers = new TimerSet(clock);
    const settleTimers = new TimerSet(clock);
    // public-hardening Requirement 5.1: credits survive a restart (the file is read synchronously
    // and a corrupt one stops the start, so no credits are silently lost).
    const creditsFile =
      opts.store === undefined
        ? new CreditsFile(config.workspaces, (what, reason) => {
            logger.warn("credits file entry skipped", { entry: what, reason });
          })
        : undefined;
    const store: SessionStore = opts.store ?? creditsFile ?? new MemorySessionStore();
    const daily = new DailyBudget(() => clock.now(), config.dailyCreditCap, creditsFile?.daily());
    // Requirement 5.3: the kill switch is a file, so an operator can pause without a restart.
    const killSwitchFile = config.killSwitchFile ?? join(config.workspaces, ".seance-paused");
    const paused = (): boolean => existsSync(killSwitchFile);
    const snapshot = new WhoisSnapshot();
    const channelLog = new ChannelLog();
    // Requirement 3: with ircd accounts an inviter must be logged in as its own account.
    const inviters = parseInviters(config.inviters, {
      required: host.accountsEnabled === true,
      accountOf: (nick) => host.accountOf?.(nick),
    });
    const gate = new InviteGate(config.inviteRate);
    const worktrees = new WorktreeManager({
      repo: config.targetRepo,
      root: config.workspaces,
      git: createGitRunner(config.targetRepo, {
        hardened: podman,
        timeoutMs: config.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
      }),
      hardened: podman,
      maxBytes: config.worktreeMaxBytes ?? HARDENING_DEFAULTS.worktreeMaxBytes,
    });

    // Requirement 6.2: every token value in the mounted Kiro login is redacted from agent text.
    const authSecrets = podman
      ? await readAuthSecrets(sandboxConfig.authDir, (path, reason) => {
          logger.warn("auth file skipped for redaction", { path, reason });
        })
      : [];
    const redactor = new SecretRedactor([config.kiroApiKey, ...authSecrets]);

    const humanOpNicks = (channel: string): readonly string[] => {
      const members = host.channel(channel)?.members;
      if (members === undefined) return [];
      const nicks: string[] = [];
      for (const [id, membership] of members) {
        if (!membership.op) continue;
        const client = host.clientById(id);
        const nick = client?.nick;
        if (nick === undefined || client?.virtual === true) continue;
        if (registry.lookup(nick) !== undefined) continue;
        nicks.push(nick);
      }
      return nicks;
    };
    const notifyOps = (channel: string, text: string): void => {
      opNotice(host, logger, humanOpNicks, channel, text);
    };
    // runner-services: ChanServ / NickServ notices, each sent where its fact is observed.
    const services = createServices({ host, logger });

    // Forward references: the ledger and the manager need each other.
    let sessions: SessionManager;
    const harnessSessions = new WeakMap<Session, HarnessSession>();
    const outputs = new Map<string, AgentOutput>();

    const ledger = new CreditLedger({
      store,
      snapshot,
      clock,
      logger,
      ...(config.channelCreditCap !== undefined ? { cap: config.channelCreditCap } : {}),
      sessionsOf: (channel) => sessions.sessionsOf(channel),
      opNotice: notifyOps,
      acpSessionIdOf: (agent, channel) => sessions.channelSession(agent, channel)?.acpSessionId,
      // public-hardening Requirement 5.2: one budget for all agents per UTC day.
      daily,
      ...(creditsFile !== undefined ? { persistDaily: (state) => creditsFile.putDaily(state) } : {}),
      // Requirement 12.2: private turns are cancelled too when the daily cap is crossed.
      allSessions: () => sessions.allSessions(),
      onDailyCapReached: () => {
        const channels = new Set<string>();
        for (const s of sessions.allChannelSessions()) {
          if (s.state !== "closed") channels.add(s.channel);
        }
        for (const channel of channels) services.chanServ(channel, "daily credit budget reached");
      },
    });
    await ledger.restore();

    // agent-sandbox Requirement 14: host-side commits exist only in podman mode (14.8).
    const commitTurn = podman
      ? createTurnCommitter({
          host,
          worktrees,
          logger,
          chanServ: (channel, text) => {
            services.chanServ(channel, text);
          },
          opNotice: notifyOps,
        })
      : undefined;
    const idleTimeoutS = config.idleTimeoutS ?? DEFAULT_IDLE_TIMEOUT_S;
    const channelDeps: ChannelSessionDeps = {
      host,
      worktrees,
      snapshot,
      ledger,
      clock,
      timers,
      logger,
      opNotice: notifyOps,
      ...(commitTurn !== undefined ? { commitTurn } : {}),
      // agent-runner Requirement 9.18: an idle session is exorcised like a KICK, in both sandbox modes.
      idle: {
        timeoutS: idleTimeoutS,
        onIdle: (session) => {
          if (shuttingDown || session.state === "closed") return;
          logger.info("session idle, exorcising", { agent: session.agent, channel: session.channel, idleTimeoutS });
          void exorcise(session, "idle");
        },
      },
    };
    // Requirements 5.2, 5.3: the daily cap and the kill switch refuse new turns everywhere.
    const globallyBlocked = (): boolean => ledger.dailyCapReached() || paused();
    const isBlocked = (channel: string): boolean => ledger.isBlocked(channel) || globallyBlocked();
    // Requirement 5.5: at most N channels with agents, and at most M sandbox containers.
    const maxAgentChannels = config.maxAgentChannels ?? HARDENING_DEFAULTS.maxAgentChannels;
    const maxContainers = config.maxContainers ?? HARDENING_DEFAULTS.maxContainers;
    const capacity = (channel: string, pendingChannels: readonly string[]): string | undefined => {
      if (globallyBlocked()) {
        return paused() ? "agents are paused by the operator" : "daily credit budget reached";
      }
      const live = sessions.allChannelSessions().filter((s) => s.state !== "closed");
      const active = new Set([...live.map((s) => irc_lower(s.channel)), ...pendingChannels.map((c) => irc_lower(c))]);
      if (!active.has(irc_lower(channel)) && active.size >= maxAgentChannels) {
        return `at most ${maxAgentChannels} channels may have agents at once`;
      }
      return containersFull(pendingChannels.length);
    };
    // Revivals in flight hold a container slot before their Session is registered.
    let reviving = 0;
    /** Requirement 5.5 / 12.3: open channel Sessions + starts + revivals + Private_Sessions. */
    const containersFull = (pendingStarts: number): string | undefined => {
      const live = sessions.allChannelSessions().filter((s) => s.state !== "closed").length;
      return live + pendingStarts + reviving + sessions.privateCount() >= maxContainers
        ? `at most ${maxContainers} agent sessions may run at once`
        : undefined;
    };

    // Same session-creation logic as the InviteController (shared helpers).
    const reviveSession = async (reg: AgentRegistration, channel: string): Promise<Session> => {
      // public-hardening Requirement 12.3: a revival starts a container too, so it obeys the cap.
      const full = containersFull(invites.pendingStarts());
      // The SessionManager logs the reason and posts "could not be started" in the channel.
      if (full !== undefined) throw new Error(`revival refused: ${full}`);
      reviving += 1;
      try {
        return await openRevived(reg, channel);
      } finally {
        reviving -= 1;
      }
    };
    const openRevived = async (reg: AgentRegistration, channel: string): Promise<Session> => {
      const info = await worktrees.ensure(channel);
      let harnessSession: HarnessSession;
      const permissions = new PendingPermissions();
      try {
        harnessSession = await harness.openSession(reg.profile, {
          cwd: info.realPath,
          onPermission: channelPermissionHandler(
            channelDeps,
            reg.profile,
            channel,
            info.realPath,
            reg.output,
            permissions,
          ),
        });
      } catch (err) {
        // agent-sandbox Requirement 11.1: the Human_Ops learn why the agent did not come back.
        if (err instanceof SandboxError) {
          logger.error("sandbox start failed", { agent: reg.profile.nick, channel, kind: err.kind, cause: err.message });
          notifyOps(channel, sandboxNotice(reg.profile.nick, channel, err));
        }
        throw err;
      }
      try {
        const session = buildChannelSession(
          channelDeps,
          reg.profile,
          channel,
          harnessSession,
          reg.output,
          isBlocked,
          permissions,
        );
        harnessSessions.set(session, harnessSession);
        return session;
      } catch (err) {
        await harnessSession.close().catch((closeErr: unknown) => {
          logger.error("harness session close failed", { reason: messageOf(closeErr) });
        });
        throw err;
      }
    };

    sessions = new SessionManager({
      host,
      registry,
      harness,
      worktrees,
      channelLog,
      ledger,
      clock,
      timers,
      logger,
      reviveSession,
      inviters,
      globallyBlocked,
      privateCapacity: () => containersFull(invites.pendingStarts()),
      idleTimeoutS,
    });
    const sessionManager = sessions;

    // Exorcism: kick / own PART / QUIT.
    let invites: InviteController;
    const exorcise = createExorcist({
      host,
      sessions: {
        removeChannelSession: (agent, channel) => {
          sessionManager.removeChannelSession(agent, channel);
          // Req 3.13: the Invite_Key leaves the dedup state when the Session reaches `closed`.
          gate.release(`${irc_lower(agent)}\0${irc_lower(channel)}`);
        },
      },
      worktrees,
      timers,
      logger,
      clientOf: (agent) => invites.agentClient(agent),
      report: (channel, text) => {
        logger.error(text, { channel });
        notifyOps(channel, text);
      },
      closeHarnessSession: async (session) => {
        await harnessSessions.get(session)?.close();
      },
      chanServ: (channel, text) => {
        services.chanServ(channel, text);
      },
      creditsOf: (agent, channel) => ledger.amount(agent, channel),
      idleMinutes: idleMinutes(idleTimeoutS),
    });
    const triggers = createExorcismTriggers({
      host,
      sessions: sessionManager,
      exorcise,
      logger,
    });
    const agentWatchers = new Set<Unsubscribe>();

    invites = new InviteController({
      sandboxMode: sandboxConfig.mode,
      host,
      registry,
      bans,
      inviters,
      gate,
      sessions: {
        addChannelSession: (s) => {
          sessionManager.addChannelSession(s);
        },
        channelSession: (agent, channel) => sessionManager.channelSession(agent, channel),
        setInviter: (agent, channel, inviter) => {
          sessionManager.setInviter(agent, channel, inviter);
        },
        registerAgent: (reg) => {
          outputs.set(irc_lower(reg.profile.nick), reg.output);
          const offManager = sessionManager.registerAgent(reg);
          const offWatch = triggers.watchAgent(reg.profile.nick, reg.client);
          const off: Unsubscribe = () => {
            offManager();
            offWatch();
            agentWatchers.delete(off);
          };
          agentWatchers.add(off);
          return off;
        },
      },
      worktrees,
      harness,
      snapshot,
      ledger,
      store,
      channelLog,
      clock,
      timers,
      logger,
      opNotice: notifyOps,
      isBlocked,
      ...(channelDeps.idle !== undefined ? { idle: channelDeps.idle } : {}),
      services: { chanServ: services.chanServ, workspaces: config.workspaces },
      secrets: [config.kiroApiKey],
      redactor,
      capacity,
      budgetLine: () => daily.line(paused()),
      ...(commitTurn !== undefined ? { commitTurn } : {}),
      onHarnessSession: (session, harnessSession) => {
        harnessSessions.set(session, harnessSession);
      },
    });
    const inviteController = invites;

    const resolver = createInviteResolver({ registry, bans, inviters });

    // Subscriptions. Invites and messages are refused once shutdown began (Req 11.1, 11.2).
    const unsubscribers: Unsubscribe[] = [];
    unsubscribers.push(
      host.subscribe("irc.invite", (e) => {
        if (shuttingDown) return;
        void inviteController.handleInvite(e);
      }),
      host.subscribe("irc.message", (e) => {
        if (shuttingDown) return;
        sessionManager.onChannelMessage(e);
      }),
      // runner-services Req 4: NickServ greets a human once, with the roster as WHOIS sees it.
      host.subscribe("irc.register", (e) => {
        if (!started || shuttingDown || e.virtual) return;
        const roster = registry.all().map((p) => ({ nick: p.nick, status: agentStatus(snapshot.get(p.nick)) }));
        services.nickServ(e.nick, agentsOnline(roster));
      }),
      // Modes are read live through `host.modeOf`; the event is only traced.
      host.subscribe("irc.mode", (e) => {
        logger.debug("channel mode changed", {
          channel: e.channel,
          mode: e.mode,
          adding: e.adding,
        });
      }),
      // A kick that lands while the agent is still starting aborts that start.
      host.subscribe("irc.kick", (e) => {
        if (registry.lookup(e.target) === undefined) return;
        inviteController.abort(e.target, e.channel).catch((err: unknown) => {
          logger.error("abort of in-flight start failed", { reason: messageOf(err) });
        });
      }),
      sessionManager.attach(),
      installHungHandler(harness, {
        sessionsOfAgent: (agent) => sessionManager.sessionsOfAgent(agent),
        outputOf: (agent) => outputs.get(irc_lower(agent)),
        onError: (channel, error) => {
          logger.error("hung notice failed", { channel, reason: messageOf(error) });
        },
      }),
      () => {
        triggers.dispose();
      },
    );

    const allSessions = (): readonly Session[] =>
      registry.all().flatMap((p) => sessionManager.sessionsOfAgent(p.nick));

    const waitSettled = (session: Session): Promise<void> => {
      const settled = (): boolean => session.state === "idle" || session.state === "closed";
      if (settled()) return Promise.resolve();
      return new Promise<void>((resolve) => {
        let waited = 0;
        const tick = (): void => {
          waited += SETTLE_POLL_MS;
          if (settled() || waited >= SETTLE_MAX_MS) resolve();
          else settleTimers.set(tick, SETTLE_POLL_MS);
        };
        settleTimers.set(tick, SETTLE_POLL_MS);
      });
    };

    const shutdown = createShutdown({
      logger,
      clock,
      markShuttingDown: () => {
        shuttingDown = true;
      },
      cancelAndCloseSessions: async () => {
        const live = allSessions().filter((s) => s.state !== "closed");
        for (const s of live) {
          s.beginClosing();
          if (s.state === "prompting") s.cancel();
        }
        await Promise.all(live.map((s) => waitSettled(s)));
        for (const s of live) {
          if (s.state !== "closed") s.close("shutdown");
          await harnessSessions.get(s)?.close().catch((err: unknown) => {
            logger.error("harness session close failed", {
              agent: s.agent,
              channel: s.channel,
              reason: messageOf(err),
            });
          });
        }
        await sessionManager.closePrivateSessions("shutdown");
      },
      disposeHarness: () => harness.dispose(),
      killRemainingProcesses: () => {
        for (const p of registry.all()) {
          if (!harness.hasProcess(p)) continue;
          harness.terminate(p, "SIGKILL").catch((err: unknown) => {
            logger.error("SIGKILL failed", { agent: p.nick, reason: messageOf(err) });
          });
        }
      },
      closeVirtualClients: (reason) => {
        for (const p of registry.all()) inviteController.agentClient(p.nick)?.close(reason);
      },
      timerSets: [timers, settleTimers],
      unsubscribers: [...unsubscribers, () => [...agentWatchers].forEach((off) => off())],
      flushLedger: async () => {
        await ledger.flush();
        await creditsFile?.flush();
      },
      liveProcessCount: () => registry.all().filter((p) => harness.hasProcess(p)).length,
    });

    return { resolver, shutdown, agentNicks: registry.all().map((p) => p.nick) };
  }

  return {
    inviteResolver,
    ban: (channel, nick) => {
      bans.add(channel, nick);
    },
    unban: (channel, nick) => bans.remove(channel, nick),
    agentNicks: () => parts?.agentNicks ?? [],
    start() {
      if (shuttingDown) return Promise.reject(new Error("runner is shutting down"));
      starting ??= setup().then(
        (built) => {
          parts = built;
          started = true;
          logger.info("runner started");
        },
        (err: unknown) => {
          starting = undefined;
          throw err;
        },
      );
      return starting;
    },
    async shutdown() {
      shuttingDown = true;
      if (starting !== undefined) await starting.catch(() => undefined);
      if (parts === undefined) return EMPTY_REPORT;
      return parts.shutdown.run();
    },
  };
}
