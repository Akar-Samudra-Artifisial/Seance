/**
 * A single IRC message (RFC 2812 §2.3.1), without the trailing CRLF.
 *
 * `params` holds every parameter in order; the trailing parameter (the one
 * introduced by `:`) is stored as the last element without its colon.
 */
export interface IrcMessage {
  /** Message prefix (server name or `nick!user@host`), without the leading `:`. */
  readonly prefix?: string;
  /** Command word (e.g. `PRIVMSG`) or three-digit numeric reply (e.g. `433`). */
  readonly command: string;
  /** Up to 15 parameters, in order. */
  readonly params: readonly string[];
}
