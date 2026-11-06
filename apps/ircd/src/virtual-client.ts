import { serialize } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import type { Client } from "./client.js";
import type { CommandRouter, DispatchOutcome, RouterContext } from "./command-router.js";
import { quitClient } from "./handlers/quit.js";
import { normalizeAway } from "./text-limits.js";

/**
 * In-process client used by agents (Req 12). It registers with the
 * `ConnectionManager` like a network client and its commands go through the
 * same `CommandRouter`, so permission checks, numerics and broadcasts are
 * identical to a socket client.
 */
export interface VirtualClient extends Client {
  /**
   * Send a command as this client. Throws (and does not route) when the
   * message is malformed or its serialized form exceeds 512 bytes including
   * CRLF, or when the client is closed (Req 12.4). Returns the router outcome.
   */
  dispatch(msg: IrcMessage): DispatchOutcome;
  /** Receive each server message directed at this client; returns an unsubscribe function (Req 12.1). */
  onMessage(listener: (msg: IrcMessage) => void): () => void;
  /**
   * Set or clear the away text without any wire reply. Control characters are
   * stripped and the text is clamped to AWAYLEN bytes; `undefined` or an empty
   * result clears it.
   */
  setAway(text?: string): void;
}

export interface VirtualClientOptions {
  /** Unique connection id; must not collide with any tracked client. */
  readonly id: string;
  /** Host shown in `nick!user@host`; defaults to the server name like other clients. */
  readonly host?: string;
  /** Called exactly once per WHOIS of this client; its lines become 320 replies. */
  readonly whoisExtra?: () => readonly string[];
}

class VirtualClientImpl implements VirtualClient {
  nick?: string;
  user?: string;
  host?: string;
  registered = false;
  away?: string;
  readonly virtual = true;
  whoisExtra?: () => readonly string[];
  private closed = false;
  private readonly listeners = new Set<(msg: IrcMessage) => void>();

  constructor(
    readonly id: string,
    host: string | undefined,
    private readonly ctx: RouterContext,
    private readonly router: CommandRouter,
    whoisExtra?: () => readonly string[],
  ) {
    if (host !== undefined) this.host = host;
    if (whoisExtra !== undefined) this.whoisExtra = whoisExtra;
  }

  dispatch(msg: IrcMessage): DispatchOutcome {
    if (this.closed) {
      throw new Error(`Cannot dispatch ${msg.command} for ${this.id}: the virtual client is closed`);
    }
    // Same boundary check as network output/input: reuse serialize()'s validation
    // and 512-byte limit. It throws with a reason; nothing is routed (Req 12.4).
    try {
      serialize(msg);
    } catch (error) {
      throw new Error(
        `Rejected message from virtual client ${this.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    return this.router.dispatch(this.ctx, this, msg);
  }

  onMessage(listener: (msg: IrcMessage) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setAway(text?: string): void {
    const clean = normalizeAway(text);
    if (clean === "") {
      delete this.away;
    } else {
      this.away = clean;
    }
  }

  send(msg: IrcMessage): void {
    if (this.closed) return;
    this.deliver(msg);
  }

  close(reason: string): void {
    if (this.closed) return;
    // Mirror a network client: the last thing it sees is ERROR (Req 12.3).
    this.deliver({ command: "ERROR", params: [`Closing Link: ${reason}`] });
    this.closed = true;
    this.listeners.clear();
    // Leave channels, tell peers and free the nick. When the call came from
    // quitClient itself this is a no-op (quitClient is idempotent).
    quitClient(this.ctx, this, reason);
  }

  private deliver(msg: IrcMessage): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(msg);
      } catch (error) {
        // A failing listener must not affect the server or other listeners.
        try {
          this.ctx.logger.error(
            { command: msg.command, clientId: this.id, error },
            `Virtual client listener for ${this.id} failed on ${msg.command}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        } catch {
          // Ignore logger failures.
        }
      }
    }
  }
}

/** Create a virtual client and register it with the connection manager. */
export function createVirtualClient(
  ctx: RouterContext,
  router: CommandRouter,
  options: VirtualClientOptions,
): VirtualClient {
  const client = new VirtualClientImpl(options.id, options.host, ctx, router, options.whoisExtra);
  ctx.connections.add(client);
  return client;
}
