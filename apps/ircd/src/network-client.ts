import { LineFramer, Numerics, parse, serialize } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import type { Client } from "./client.js";
import type { CommandRouter, RouterContext } from "./command-router.js";
import { realTimers } from "./connection-manager.js";
import type { TimerApi, TimerHandle } from "./connection-manager.js";
import { quitClient } from "./handlers/quit.js";
import { DEFAULT_LIMITS } from "./limits.js";
import type { SessionLimits } from "./limits.js";
import { TokenBucket } from "./token-bucket.js";

/** Transport-specific byte sink behind a {@link NetworkClient}. */
export interface Wire {
  /** Write one complete, CRLF-terminated line. */
  write(line: string): void;
  /** Close the underlying connection after pending writes. Must be idempotent. */
  end(): void;
  /** Drop the connection now, discarding pending writes. Must be idempotent. */
  destroy(): void;
  /** Bytes accepted by `write` that the peer has not yet received. */
  bufferedBytes(): number;
  /** True once the underlying connection is fully closed or destroyed. */
  isDestroyed(): boolean;
}

/** Reason recorded for the synthetic `QUIT` when a socket closes (Req 2.5). */
export const CONNECTION_CLOSED_REASON = "Connection closed";

/** A client connected over a network transport (TCP or WebSocket). */
export class NetworkClient implements Client {
  nick?: string;
  user?: string;
  host?: string;
  registered = false;
  away?: string;
  private closed = false;
  private destroyTimer: TimerHandle | undefined;
  private readonly timers: TimerApi;

  constructor(
    readonly id: string,
    host: string | undefined,
    private readonly wire: Wire,
    private readonly ctx: RouterContext,
    private readonly limits: SessionLimits = DEFAULT_LIMITS,
  ) {
    if (host !== undefined) this.host = host;
    this.timers = limits.timers ?? realTimers;
  }

  /** True once `close` ran or the connection was dropped. */
  get isClosed(): boolean {
    return this.closed;
  }

  send(msg: IrcMessage): void {
    if (this.closed) return;
    let line: string;
    try {
      line = serialize(msg);
    } catch (error) {
      // Never emit a truncated or malformed line; report and drop it (Req 1.4).
      this.ctx.logger.error(
        { command: msg.command, clientId: this.id, error },
        `Dropping unserializable ${msg.command} for ${this.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    const queued = this.wire.bufferedBytes() + Buffer.byteLength(line, "utf8");
    if (queued > this.limits.maxWriteBufferBytes) {
      // A peer that cannot drain its queue will not read an ERROR either.
      // Mark closed first so quitClient's close() does not re-enter send().
      this.closed = true;
      this.ctx.logger.error(
        { command: msg.command, clientId: this.id },
        `Write buffer for ${this.id} would reach ${queued} bytes (limit ${this.limits.maxWriteBufferBytes}); dropping client`,
      );
      this.wire.destroy();
      quitClient(this.ctx, this, "SendQ exceeded");
      return;
    }
    this.wire.write(line);
  }

  close(reason: string): void {
    if (this.closed) return;
    if (this.wire.isDestroyed()) {
      // Nothing left to flush or tear down; just stop further sends.
      this.closed = true;
      return;
    }
    try {
      this.send({ command: "ERROR", params: [`Closing Link: ${reason}`] });
    } finally {
      // send() may have destroyed the wire (SendQ exceeded) and set closed.
      const alreadyTornDown = this.closed || this.wire.isDestroyed();
      this.closed = true;
      if (!alreadyTornDown && this.destroyTimer === undefined) {
        this.wire.end();
        // A peer that never closes its side must not hold the socket forever.
        this.destroyTimer = this.timers.setTimeout(() => {
          this.destroyTimer = undefined;
          this.wire.destroy();
        }, this.limits.closeGraceMs);
      }
    }
  }

  /** Cancel the pending destroy timer; call when the socket has closed. */
  dispose(): void {
    if (this.destroyTimer !== undefined) {
      this.timers.clearTimeout(this.destroyTimer);
      this.destroyTimer = undefined;
    }
  }
}

/**
 * One connection's pipeline, shared by every transport: bytes -> `LineFramer`
 * -> flood check -> `parse()` -> `CommandRouter` (Req 2.3). Overlong lines get
 * `417` and the connection stays open (Req 1.2); parse errors are dropped by
 * the router.
 */
export class ConnectionSession {
  readonly client: NetworkClient;
  private readonly framer = new LineFramer();
  private readonly bucket: TokenBucket;
  private readonly timers: TimerApi;
  private registrationTimer: TimerHandle | undefined;
  private ended = false;

  constructor(
    private readonly ctx: RouterContext,
    private readonly router: CommandRouter,
    id: string,
    host: string | undefined,
    wire: Wire,
    limits: SessionLimits = DEFAULT_LIMITS,
  ) {
    this.client = new NetworkClient(id, host, wire, ctx, limits);
    this.bucket = new TokenBucket(limits.floodBurst, limits.floodRefillMs, limits.now);
    this.timers = limits.timers ?? realTimers;
    ctx.connections.add(this.client);
    this.registrationTimer = this.timers.setTimeout(() => {
      this.registrationTimer = undefined;
      if (!this.client.registered) {
        quitClient(this.ctx, this.client, "Registration timeout");
      }
    }, limits.registrationTimeoutMs);
  }

  /** Feed raw bytes or text received from the peer. */
  receive(chunk: Uint8Array | string): void {
    // Once closed, nothing from the peer is processed.
    if (this.ended || this.client.isClosed) return;
    for (const event of this.framer.push(chunk)) {
      // Stop once the client quit (or was removed) mid-chunk.
      if (this.ended || this.ctx.connections.get(this.client.id) !== this.client) return;
      if (!this.bucket.tryTake()) {
        quitClient(this.ctx, this.client, "Excess Flood");
        return;
      }
      if (event.kind === "overlong") {
        this.client.send({
          prefix: this.ctx.serverName,
          command: Numerics.ERR_INPUTTOOLONG,
          params: [this.client.nick ?? "*", "Input line was too long"],
        });
        continue;
      }
      this.router.dispatch(this.ctx, this.client, parse(event.line));
    }
  }

  /** The socket closed: process a synthetic `QUIT` (Req 2.5). Idempotent. */
  closed(): void {
    this.ended = true;
    if (this.registrationTimer !== undefined) {
      this.timers.clearTimeout(this.registrationTimer);
      this.registrationTimer = undefined;
    }
    this.client.dispose();
    quitClient(this.ctx, this.client, CONNECTION_CLOSED_REASON);
  }
}
