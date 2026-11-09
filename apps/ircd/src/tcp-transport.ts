import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import type { AddressInfo, Server, Socket } from "node:net";
import type { CommandRouter, RouterContext } from "./command-router.js";
import { normalizeHost } from "./host.js";
import { canonicalIp } from "./client-ip.js";
import { ConnectionGate, DEFAULT_LIMITS, PerIpGate } from "./limits.js";
import type { PassFailures } from "./limits.js";
import type { SessionLimits } from "./limits.js";
import { ConnectionSession } from "./network-client.js";
import { logSocketError } from "./socket-errors.js";

export const DEFAULT_TCP_PORT = 6667;

export interface TcpTransportOptions {
  readonly port?: number;
  readonly host?: string;
  /** Per-connection limits; defaults to {@link DEFAULT_LIMITS}. */
  readonly limits?: SessionLimits;
  /** Shared connection cap; defaults to an unshared gate with the default cap. */
  readonly gate?: ConnectionGate;
  /** Live connections per client address (public-hardening Requirement 7.2). */
  readonly perIp?: PerIpGate;
  /** Addresses refused after too many wrong PASS values (Requirement 7.3). */
  readonly passFailures?: PassFailures;
}

/** Plain-TCP IRC listener (Req 2.1). One `LineFramer` per socket. */
export class TcpTransport {
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly gate: ConnectionGate;
  private readonly perIp: PerIpGate;
  private readonly limits: SessionLimits;

  constructor(
    private readonly ctx: RouterContext,
    private readonly router: CommandRouter,
    private readonly options: TcpTransportOptions = {},
  ) {
    this.gate = options.gate ?? new ConnectionGate();
    this.perIp = options.perIp ?? new PerIpGate(Number.MAX_SAFE_INTEGER);
    this.limits = options.limits ?? DEFAULT_LIMITS;
    this.server = createServer((socket) => this.accept(socket));
  }

  /** Start listening; resolves with the bound port (useful with port 0). */
  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.server.once("error", onError);
      this.server.listen(this.options.port ?? DEFAULT_TCP_PORT, this.options.host, () => {
        this.server.off("error", onError);
        resolve((this.server.address() as AddressInfo).port);
      });
    });
  }

  /** Stop accepting and destroy open sockets. */
  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private refuse(socket: Socket, reason: string): void {
    // No client state is created for a refused connection.
    socket.on("error", () => socket.destroy());
    socket.end(`ERROR :Closing Link: ${reason}\r\n`);
    setTimeout(() => socket.destroy(), this.limits.closeGraceMs).unref();
  }

  private accept(socket: Socket): void {
    const ip = socket.remoteAddress === undefined ? undefined : canonicalIp(socket.remoteAddress);
    if (this.options.passFailures?.blocked(ip) === true) {
      this.refuse(socket, "Too many failed PASS attempts from your address");
      return;
    }
    if (!this.gate.tryAcquire()) {
      this.refuse(socket, "Too many connections");
      return;
    }
    if (!this.perIp.tryAcquire(ip)) {
      this.gate.release();
      this.refuse(socket, "Too many connections from your address");
      return;
    }
    this.sockets.add(socket);
    const session = new ConnectionSession(
      this.ctx,
      this.router,
      randomUUID(),
      normalizeHost(socket.remoteAddress),
      {
        write: (line) => {
          if (!socket.destroyed) socket.write(line);
        },
        end: () => {
          if (!socket.destroyed) socket.end();
        },
        destroy: () => socket.destroy(),
        bufferedBytes: () => socket.writableLength,
        isDestroyed: () => socket.destroyed,
      },
      this.limits,
    );
    socket.on("data", (chunk: Buffer) => session.receive(chunk));
    socket.on("error", (error) => {
      logSocketError(this.ctx.logger, "TCP socket", session.client.id, error);
      socket.destroy();
    });
    socket.on("close", () => {
      this.sockets.delete(socket);
      this.gate.release();
      this.perIp.release(ip);
      session.closed();
    });
  }
}
