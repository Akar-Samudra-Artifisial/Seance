import { irc_lower } from "@seance/irc-protocol";
import { realClock, TimerSet } from "./clock.js";
import type { Clock } from "./clock.js";
import { assertInvitersConfigured, validateRunnerPaths } from "./config.js";
import type { RunnerConfig } from "./config.js";
import { CreditLedger } from "./credits/ledger.js";
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
  /** Defaults to an in-memory store. */
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
}

const SETTLE_POLL_MS = 25;
const SETTLE_MAX_MS = 30_000;

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const EMPTY_REPORT: ShutdownReport = { errors: [], remainingTimers: 0, remainingProcesses: 0 };

/** Everything built by `start()`. */
type Parts = {
  readonly resolver: InviteResolver;
  readonly shutdown: ReturnType<typeof createShutdown>;
};

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
    const store = opts.store ?? new MemorySessionStore();
    const snapshot = new WhoisSnapshot();
    const channelLog = new ChannelLog();
    const inviters = parseInviters(config.inviters);
    const gate = new InviteGate(config.inviteRate);
    const worktrees = new WorktreeManager({
      repo: config.targetRepo,
      root: config.workspaces,
      git: createGitRunner(config.targetRepo, { hardened: podman }),
      hardened: podman,
    });

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
    };
    const isBlocked = (channel: string): boolean => ledger.isBlocked(channel);

    // Same session-creation logic as the InviteController (shared helpers).
    const reviveSession = async (reg: AgentRegistration, channel: string): Promise<Session> => {
      const info = await worktrees.ensure(channel);
      let harnessSession: HarnessSession;
      try {
        harnessSession = await harness.openSession(reg.profile, {
          cwd: info.realPath,
          onPermission: channelPermissionHandler(
            channelDeps,
            reg.profile,
            channel,
            info.realPath,
            reg.output,
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
    });
    const triggers = createExorcismTriggers({
      host,
      sessions: sessionManager,
      exorcise,
      logger,
    });
    const agentWatchers = new Set<Unsubscribe>();

    invites = new InviteController({
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
      services: { chanServ: services.chanServ, workspaces: config.workspaces },
      secrets: [config.kiroApiKey],
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
      flushLedger: () => ledger.flush(),
      liveProcessCount: () => registry.all().filter((p) => harness.hasProcess(p)).length,
    });

    return { resolver, shutdown };
  }

  return {
    inviteResolver,
    ban: (channel, nick) => {
      bans.add(channel, nick);
    },
    unban: (channel, nick) => bans.remove(channel, nick),
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
