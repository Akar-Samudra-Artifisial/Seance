import type { IrcMessage } from "@seance/irc-protocol";

/**
 * Common abstraction over every connection kind (TCP, WebSocket and the
 * in-process virtual client). Handlers only ever talk to this interface, so a
 * peer cannot tell the transports apart (Req 2.3, 12.3).
 *
 * `nick`, `user`, `registered` and `away` are mutated by `ConnectionManager`
 * and the command handlers; transports only supply `id`, `send` and `close`.
 */
export interface Client {
  /** Stable, unique connection id (never reused while the client is tracked). */
  readonly id: string;
  /** Current nickname, once a valid `NICK` has been accepted. */
  nick?: string;
  /** Username from `USER`. */
  user?: string;
  /** Real name from `USER` (shown by `WHOIS`). */
  realname?: string;
  /** Unix seconds when registration completed (`WHOIS` 317 signon). */
  signonAt?: number;
  /** Unix seconds of the last activity (`WHOIS` 317 idle is derived from it). */
  lastActivityAt?: number;
  /** Remote host shown in message prefixes; the server name is used when unset. */
  host?: string;
  /** True once `NICK` and `USER` (and `PASS`, when required) have completed. */
  registered: boolean;
  /** Away message, when the client is marked away. */
  away?: string;
  /**
   * True for in-process clients. They have no socket to probe, so the
   * `ConnectionManager` does not run idle `PING` / ping-timeout for them.
   */
  readonly virtual?: boolean;
  /**
   * public-hardening Requirement 1.5: an in-process client created by the runner for an agent. It
   * needs no PASS and may use an agent nick. Untrusted virtual clients authenticate like sockets.
   */
  readonly trusted?: boolean;
  /** The account this client logged in as (`PASS <nick>:<secret>`); undefined for guests. */
  account?: string;
  /**
   * Optional extra WHOIS lines (model, tools, credits). Untrusted data.
   * Network clients leave it unimplemented.
   */
  whoisExtra?(): readonly string[];
  /** Deliver one server message to this client. */
  send(msg: IrcMessage): void;
  /** Close the connection, giving a human-readable reason. */
  close(reason: string): void;
}
