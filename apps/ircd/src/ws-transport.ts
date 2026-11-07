import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";
import type { CommandRouter, RouterContext } from "./command-router.js";
import { normalizeHost } from "./host.js";
import { ConnectionGate, DEFAULT_LIMITS } from "./limits.js";
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
  private readonly limits: SessionLimits;

  constructor(
    private readonly ctx: RouterContext,
    private readonly router: CommandRouter,
    private readonly options: WsTransportOptions = {},
  ) {
    this.gate = options.gate ?? new ConnectionGate();
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
    this.wss.on("connection", (socket, request) =>
      this.accept(socket, request.socket.remoteAddress),
    );
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

  private accept(socket: WebSocket, remoteAddress: string | undefined): void {
    if (!this.gate.tryAcquire()) {
      // 1013 = Try Again Later. No client state is created.
      socket.on("error", () => socket.terminate());
      socket.close(1013, "Too many connections");
      setTimeout(() => socket.terminate(), this.limits.closeGraceMs).unref();
      return;
    }
    const session = new ConnectionSession(
      this.ctx,
      this.router,
      randomUUID(),
      normalizeHost(remoteAddress),
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
      session.closed();
    });
  }
}
