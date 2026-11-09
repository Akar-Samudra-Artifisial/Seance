import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { CommandRouter, RouterContext } from "./command-router.js";
import { normalizeHost } from "./host.js";
import { canonicalIp, clientIp } from "./client-ip.js";
import { ConnectionGate, DEFAULT_LIMITS, PerIpGate } from "./limits.js";
import type { PassFailures } from "./limits.js";
import type { SessionLimits } from "./limits.js";
import { ConnectionSession } from "./network-client.js";
import { isOriginAllowed } from "./origin.js";
import { logSocketError } from "./socket-errors.js";

export const DEFAULT_WS_PORT = 6680;

/** Upper bound on one WebSocket frame; far above any legal IRC line. */
const MAX_FRAME_BYTES = 64 * 1024;

export interface WsTransportOptions {
  readonly port?: number;
  readonly host?: string;
  /**
   * Origins (`scheme://host[:port]`, lower-case) allowed to open a WebSocket,
   * or `*` for any. Upgrades without an `Origin` header (non-browser clients)
   * are always accepted; any upgrade with one needs a match.
   */
  readonly allowedOrigins?: readonly string[];
  /** Per-connection limits; defaults to {@link DEFAULT_LIMITS}. */
  readonly limits?: SessionLimits;
  /** Shared connection cap; defaults to an unshared gate with the default cap. */
  readonly gate?: ConnectionGate;
  /** Live connections per client address (public-hardening Requirement 7.2). */
  readonly perIp?: PerIpGate;
  /** Addresses refused after too many wrong PASS values (Requirement 7.3). */
  readonly passFailures?: PassFailures;
  /** Proxies whose X-Forwarded-For is believed (Requirement 7.1); empty: always the socket peer. */
  readonly trustedProxies?: ReadonlySet<string>;
}

/**
 * WebSocket IRC listener on Fastify + `ws` (Req 2.2). Each text frame goes
 * through a per-connection `LineFramer`, so a frame may hold several lines or
 * a partial line (Req 2.4).
 */
export class WsTransport {
  private readonly app: FastifyInstance;
  private readonly wss: WebSocketServer;
  private readonly gate: ConnectionGate;
  private readonly perIp: PerIpGate;
  private readonly limits: SessionLimits;

  constructor(
    private readonly ctx: RouterContext,
    private readonly router: CommandRouter,
    private readonly options: WsTransportOptions = {},
  ) {
    this.gate = options.gate ?? new ConnectionGate();
    this.perIp = options.perIp ?? new PerIpGate(Number.MAX_SAFE_INTEGER);
    this.limits = options.limits ?? DEFAULT_LIMITS;
    const allowedOrigins = options.allowedOrigins ?? [];
    this.app = Fastify({ logger: false });
    this.app.get("/healthz", () => ({ status: "ok" }));
    this.wss = new WebSocketServer({
      server: this.app.server,
      maxPayload: MAX_FRAME_BYTES,
      verifyClient: (info, done) => {
        if (isOriginAllowed(info.origin, allowedOrigins)) {
          done(true);
        } else {
          done(false, 403, "Origin not allowed");
        }
      },
    });
    this.wss.on("connection", (socket, request) => {
      const header = request.headers["x-forwarded-for"];
      const forwarded = Array.isArray(header) ? header.join(",") : header;
      const peer = request.socket.remoteAddress;
      const ip = clientIp(peer, forwarded, options.trustedProxies ?? new Set());
      // The shown host stays the raw peer (normalised as before) unless a trusted proxy named the client.
      const proxied = peer !== undefined && ip !== undefined && ip !== canonicalIp(peer);
      this.accept(socket, ip, proxied ? ip : peer);
    });
  }

  /** Start listening; resolves with the bound port (useful with port 0). */
  async listen(): Promise<number> {
    await this.app.listen({
      port: this.options.port ?? DEFAULT_WS_PORT,
      ...(this.options.host !== undefined ? { host: this.options.host } : {}),
    });
    const address = this.app.server.address();
    if (address === null || typeof address === "string") {
      throw new Error("WebSocket server did not report a TCP address");
    }
    return address.port;
  }

  async close(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve) => {
      this.wss.close(() => resolve());
    });
    await this.app.close();
  }

  private refuse(socket: WebSocket, reason: string): void {
    // 1013 = Try Again Later. No client state is created.
    socket.on("error", () => socket.terminate());
    socket.close(1013, reason);
    setTimeout(() => socket.terminate(), this.limits.closeGraceMs).unref();
  }

  private accept(socket: WebSocket, remoteAddress: string | undefined, hostSource: string | undefined): void {
    if (this.options.passFailures?.blocked(remoteAddress) === true) {
      this.refuse(socket, "Too many failed PASS attempts");
      return;
    }
    if (!this.gate.tryAcquire()) {
      this.refuse(socket, "Too many connections");
      return;
    }
    if (!this.perIp.tryAcquire(remoteAddress)) {
      this.gate.release();
      this.refuse(socket, "Too many connections from your address");
      return;
    }
    const session = new ConnectionSession(
      this.ctx,
      this.router,
      randomUUID(),
      normalizeHost(hostSource),
      {
        write: (line) => {
          if (socket.readyState === socket.OPEN) socket.send(line);
        },
        end: () => {
          if (socket.readyState === socket.OPEN) socket.close(1000);
        },
        destroy: () => socket.terminate(),
        bufferedBytes: () => socket.bufferedAmount,
        isDestroyed: () => socket.readyState === socket.CLOSED,
      },
      this.limits,
    );
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, "Text frames only");
        return;
      }
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString("utf8")
        : data instanceof ArrayBuffer
          ? Buffer.from(data).toString("utf8")
          : data.toString("utf8");
      session.receive(text);
    });
    socket.on("error", (error) => {
      logSocketError(this.ctx.logger, "WebSocket", session.client.id, error);
      socket.terminate();
    });
    socket.on("close", () => {
      this.gate.release();
      this.perIp.release(remoteAddress);
      session.closed();
    });
  }
}
