import { irc_lower, isValidChannel } from "@seance/irc-protocol";

/** Per-member channel status: `op` = `+o`, `voice` = `+v`. */
export type Membership = { op: boolean; voice: boolean };

export type Channel = {
  /** Name as given by the creating join; always starts with `#`. */
  readonly name: string;
  topic?: string;
  modes: { moderated: boolean };
  /** Keyed by `Client.id`. */
  readonly members: Map<string, Membership>;
  /**
   * Invite records keyed by `irc_lower(nick)` (Req 7). Never consulted by
   * `join`; a later invite-only mode may use it.
   */
  readonly invited: Set<string>;
};

/** Outcome of {@link ChannelRegistry.join}. */
export type JoinResult =
  | { readonly kind: "created"; readonly channel: Channel }
  | { readonly kind: "joined"; readonly channel: Channel }
  | { readonly kind: "already-member"; readonly channel: Channel };

/**
 * Owns all channels, membership and channel modes. Channels are keyed by
 * `irc_lower(name)` (rfc1459 case-mapping). A channel is created on first
 * join (creator gets `+o`, Req 5.1) and deleted when its last member leaves,
 * discarding topic and mode state (Req 5.8).
 */
export class ChannelRegistry {
  private readonly channels = new Map<string, Channel>();

  /**
   * Add a client to a channel, creating it if needed. Throws on an invalid
   * channel name; callers map that to `403 ERR_NOSUCHCHANNEL` beforehand.
   * Joining a channel the client is already in changes nothing (Req 5.5).
   */
  join(clientId: string, name: string, nick?: string): JoinResult {
    if (!isValidChannel(name)) {
      throw new Error(`Cannot join: "${name}" is not a valid channel name`);
    }
    const key = irc_lower(name);
    const existing = this.channels.get(key);
    if (existing === undefined) {
      const channel: Channel = {
        name,
        modes: { moderated: false },
        members: new Map([[clientId, { op: true, voice: false }]]),
        invited: new Set(),
      };
      this.channels.set(key, channel);
      return { kind: "created", channel };
    }
    if (existing.members.has(clientId)) {
      return { kind: "already-member", channel: existing };
    }
    existing.members.set(clientId, { op: false, voice: false });
    if (nick !== undefined) existing.invited.delete(irc_lower(nick));
    return { kind: "joined", channel: existing };
  }

  /**
   * Record an invite for `nick`. Returns false when the channel does not
   * exist (nothing recorded). Re-inviting is idempotent.
   */
  invite(name: string, nick: string): boolean {
    const channel = this.get(name);
    if (channel === undefined) return false;
    channel.invited.add(irc_lower(nick));
    return true;
  }

  /** Whether an invite record exists for `nick` on the channel. */
  isInvited(name: string, nick: string): boolean {
    return this.get(name)?.invited.has(irc_lower(nick)) === true;
  }

  /**
   * Remove a client from a channel, deleting the channel if it becomes empty.
   * Returns false when the channel does not exist or the client is not in it
   * (caller replies `442`, Req 5.6).
   */
  part(clientId: string, name: string): boolean {
    const key = irc_lower(name);
    const channel = this.channels.get(key);
    if (channel === undefined || !channel.members.delete(clientId)) return false;
    if (channel.members.size === 0) this.channels.delete(key);
    return true;
  }

  /**
   * Remove a client from every channel (QUIT, Req 11.3). Returns the channels
   * the client was in, including any that were deleted as a result.
   */
  removeClient(clientId: string): readonly Channel[] {
    const affected: Channel[] = [];
    for (const [key, channel] of [...this.channels]) {
      if (!channel.members.delete(clientId)) continue;
      affected.push(channel);
      if (channel.members.size === 0) this.channels.delete(key);
    }
    return affected;
  }

  get(name: string): Channel | undefined {
    return this.channels.get(irc_lower(name));
  }

  has(name: string): boolean {
    return this.channels.has(irc_lower(name));
  }

  /** Snapshot of all channels. */
  list(): readonly Channel[] {
    return [...this.channels.values()];
  }

  /** Channels the client is a member of. */
  channelsOf(clientId: string): readonly Channel[] {
    return this.list().filter((c) => c.members.has(clientId));
  }

  /**
   * Shape expected by `ConnectionManager`: for a client id, one iterable of
   * member ids per channel it is in.
   */
  readonly memberIdsLookup = (clientId: string): Iterable<Iterable<string>> =>
    this.channelsOf(clientId).map((c) => [...c.members.keys()]);

  isMember(name: string, clientId: string): boolean {
    return this.get(name)?.members.has(clientId) === true;
  }

  /** True when the client is a member of the channel with `+o`. */
  isOp(name: string, clientId: string): boolean {
    return this.get(name)?.members.get(clientId)?.op === true;
  }

  /**
   * Whether the client may send to the channel. Non-members never can
   * (Req 6.5). Under `+m` only `+o` or `+v` members can (Req 6.6).
   */
  canSpeak(name: string, clientId: string): boolean {
    const channel = this.get(name);
    const membership = channel?.members.get(clientId);
    if (channel === undefined || membership === undefined) return false;
    return !channel.modes.moderated || membership.op || membership.voice;
  }
}
