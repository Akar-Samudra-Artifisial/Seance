import { ChannelRegistry } from "./channel-registry.js";
import { CommandRouter } from "./command-router.js";
import type { InviteResolver, RouterContext, RouterLogger } from "./command-router.js";
import type { ServerConfig } from "./config.js";
import { ConnectionManager } from "./connection-manager.js";
import { EventBus } from "./event-bus.js";
import { createServices } from "./services.js";
import type { Services } from "./services.js";
import { ConnectionGate, PassFailures, PerIpGate } from "./limits.js";
import type { SessionLimits } from "./limits.js";
import { registerAwayHandler } from "./handlers/away.js";
import { registerInviteHandler } from "./handlers/invite.js";
import { registerJoinHandler } from "./handlers/join.js";
import { registerKeepAliveHandlers } from "./handlers/keepalive.js";
import { registerKickHandler } from "./handlers/kick.js";
import { registerListHandler } from "./handlers/list.js";
import { registerModeHandler } from "./handlers/mode.js";
import { registerNamesHandler } from "./handlers/names.js";
import { registerNoticeHandler } from "./handlers/notice.js";
import { registerPartHandler } from "./handlers/part.js";
import { registerPrivmsgHandler } from "./handlers/privmsg.js";
import { registerQuitHandler } from "./handlers/quit.js";
import { registerRegistrationHandlers } from "./handlers/registration.js";
import { registerTopicHandler } from "./handlers/topic.js";
import { registerWhoisHandler } from "./handlers/whois.js";
import { TcpTransport } from "./tcp-transport.js";
import { createVirtualClient } from "./virtual-client.js";
import type { VirtualClient, VirtualClientOptions } from "./virtual-client.js";
import { WsTransport } from "./ws-transport.js";

/** Optional injectables for `createServer`. */
export interface ServerOptions {
  /** Clock in milliseconds; feeds `ctx.now` and `SessionLimits.now`. */
  readonly now?: () => number;
  /** Claims unregistered `INVITE` targets. */
  readonly inviteResolver?: InviteResolver;
  /** Agent registry nicks, reserved in Auth_Mode (public-hardening Requirement 2.4); read lazily. */
  readonly reservedNicks?: () => Iterable<string>;
}

export interface IrcServer {
  readonly ctx: RouterContext;
  readonly router: CommandRouter;
  readonly events: EventBus;
  /** ChanServ / NickServ notices (runner-services Req 2). */
  readonly services: Services;
  /** Connect an in-process client (for agents); it must still register via NICK/USER. */
  createVirtualClient(options: VirtualClientOptions): VirtualClient;
  /** Bind both transports; resolves with the bound ports. */
  start(): Promise<{ readonly tcpPort: number; readonly wsPort: number }>;
  stop(): Promise<void>;
}

/** Router with every command handler registered. */
export function createRouter(): CommandRouter {
  const router = new CommandRouter();
  registerRegistrationHandlers(router);
  registerKeepAliveHandlers(router);
  registerJoinHandler(router);
  registerPartHandler(router);
  registerPrivmsgHandler(router);
  registerNoticeHandler(router);
  registerTopicHandler(router);
  registerNamesHandler(router);
  registerListHandler(router);
  registerModeHandler(router);
  registerKickHandler(router);
  registerInviteHandler(router);
  registerQuitHandler(router);
  registerAwayHandler(router);
  registerWhoisHandler(router);
  return router;
}

/** Assemble state, router, event bus and both transports (not yet listening). */
export function createServer(
  config: ServerConfig,
  logger: RouterLogger,
  options: ServerOptions = {},
): IrcServer {
  const channels = new ChannelRegistry();
  const connections = new ConnectionManager(channels.memberIdsLookup, {
    serverName: config.serverName,
    idleIntervalMs: config.idleIntervalMs,
    pingTimeoutMs: config.pingTimeoutMs,
  });
  const events = new EventBus();
  // public-hardening Requirement 7: per-address limits shared by both transports.
  const passFailures = new PassFailures(config.maxPassFailuresPerIp, options.now ?? Date.now);
  const perIp = new PerIpGate(config.maxConnectionsPerIp);
  const ctx: RouterContext = {
    connections,
    channels,
    serverName: config.serverName,
    ...(config.serverPassword !== undefined ? { serverPassword: config.serverPassword } : {}),
    logger,
    events,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.inviteResolver !== undefined ? { inviteResolver: options.inviteResolver } : {}),
    ...(config.accounts !== undefined ? { accounts: config.accounts } : {}),
    ...(options.reservedNicks !== undefined ? { reservedNicks: options.reservedNicks } : {}),
    passFailures,
  };
  const router = createRouter();
  const hostOption = config.host !== undefined ? { host: config.host } : {};
  const gate = new ConnectionGate(config.maxConnections);
  const limits: SessionLimits = {
    floodBurst: config.floodBurst,
    floodRefillMs: config.floodRefillMs,
    registrationTimeoutMs: config.registrationTimeoutMs,
    maxWriteBufferBytes: config.maxWriteBufferBytes,
    closeGraceMs: config.closeGraceMs,
    ...(options.now !== undefined ? { now: options.now } : {}),
  };
  const tcp = new TcpTransport(ctx, router, {
    port: config.tcpPort,
    gate,
    perIp,
    passFailures,
    limits,
    ...hostOption,
  });
  const ws = new WsTransport(ctx, router, {
    port: config.wsPort,
    gate,
    perIp,
    passFailures,
    trustedProxies: config.trustedProxies,
    limits,
    allowedOrigins: config.wsAllowedOrigins,
    ...hostOption,
  });

  const services = createServices(ctx);

  return {
    ctx,
    router,
    events,
    services,
    createVirtualClient(options) {
      return createVirtualClient(ctx, router, options);
    },
    async start() {
      const tcpPort = await tcp.listen();
      try {
        const wsPort = await ws.listen();
        return { tcpPort, wsPort };
      } catch (error) {
        await tcp.close();
        throw error;
      }
    },
    async stop() {
      await Promise.all([tcp.close(), ws.close()]);
    },
  };
}
