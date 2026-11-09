import type { IrcMessage } from "@seance/irc-protocol";

/**
 * Structural ports of the ircd. The runner never imports `@seance/ircd`;
 * `apps/ircd/src/runner-wiring.ts` adapts an `IrcServer` to `IrcHost`.
 */

export type Unsubscribe = () => void;
export type HostMembership = { readonly op: boolean; readonly voice: boolean };

export interface HostClient {
  readonly id: string;
  readonly nick?: string;
  readonly virtual?: boolean;
  /** Used only for server-prefixed NOTICE (D8). */
  send(msg: IrcMessage): void;
}

export interface HostVirtualClient extends HostClient {
  /** Throws on malformed, overlong or closed clients. */
  dispatch(msg: IrcMessage): unknown;
  onMessage(listener: (msg: IrcMessage) => void): Unsubscribe;
  setAway(text?: string): void;
  close(reason: string): void;
}

export interface HostChannel {
  readonly name: string;
  readonly topic?: string;
  readonly modes: { readonly moderated: boolean };
  /** Keyed by client id. */
  readonly members: ReadonlyMap<string, HostMembership>;
}

export interface HostEvents {
  "irc.invite": {
    channel: string;
    inviter: string;
    target: string;
    targetKey: string;
    targetOnline: boolean;
    ts: number;
  };
  "irc.message": { channel: string; from: string; message: IrcMessage };
  "irc.mode": {
    channel: string;
    by: string;
    mode: "o" | "v" | "m";
    adding: boolean;
    target?: string;
  };
  "irc.kick": { channel: string; by: string; target: string; reason: string };
  /** A client finished registration (runner-services Req 3); no host, user or address. */
  "irc.register": { nick: string; virtual: boolean };
}

/** The network services (runner-services Req 1); the same spellings as `SERVICE_NICKS`. */
export type ServiceName = "ChanServ" | "NickServ";

export interface IrcHost {
  readonly serverName: string;
  createVirtualClient(o: {
    id: string;
    host?: string;
    whoisExtra?: () => readonly string[];
    /** An agent client: needs no PASS and may use an agent nick (public-hardening Req 1.5). */
    trusted?: boolean;
  }): HostVirtualClient;
  /** public-hardening Requirement 3: the ircd has accounts (IRCD_ACCOUNTS_FILE). Absent means no. */
  readonly accountsEnabled?: boolean;
  /** The account a registered client logged in as, or undefined (guest, unknown nick). */
  accountOf?(nick: string): string | undefined;
  /** True when `nick` is an account nick (whether or not it is connected). */
  isAccount?(nick: string): boolean;
  subscribe<K extends keyof HostEvents>(
    name: K,
    l: (e: HostEvents[K]) => void,
  ): Unsubscribe;
  /** Registered clients only. */
  clientByNick(nick: string): HostClient | undefined;
  /** Registered clients by `HostClient.id`; maps `HostChannel.members` keys to nicks. */
  clientById(id: string): HostClient | undefined;
  channel(name: string): HostChannel | undefined;
  /** Mode of `nick` in `channel` read now; undefined when not a member. */
  modeOf(channel: string, nick: string): HostMembership | undefined;
  /** Server-prefixed NOTICE to one client (D8); false when the nick is not connected. */
  noticeTo(nick: string, text: string): boolean;
  /**
   * `NOTICE` from `<service>!<service>@services.<server>` to a channel (every member, modes
   * bypassed) or a registered nick (runner-services Req 2). False when the target does not exist.
   * Never published as `irc.message`; never throws.
   */
  serviceNotice(service: ServiceName, target: string, text: string): boolean;
}
