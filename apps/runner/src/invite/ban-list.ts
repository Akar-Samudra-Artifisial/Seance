import { irc_lower } from "@seance/irc-protocol";

function banKey(channel: string, nick: string): string {
  return `${irc_lower(channel)}\0${irc_lower(nick)}`;
}

/** Runner-level per-channel agent bans (fed by the ircd's `MODE +b`/`-b` events, see `banNickOf` in runner.ts). Keys use `irc_lower`. */
export class BanList {
  readonly #keys = new Set<string>();

  add(channel: string, nick: string): void {
    this.#keys.add(banKey(channel, nick));
  }

  /** Returns whether an entry was removed. */
  remove(channel: string, nick: string): boolean {
    return this.#keys.delete(banKey(channel, nick));
  }

  has(channel: string, nick: string): boolean {
    return this.#keys.has(banKey(channel, nick));
  }
}
