import { irc_lower } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import type { Client } from "./client.js";

/**
 * Minimal view of channel membership needed to find a client's peers.
 * `ChannelRegistry` (task 3.2) will satisfy this; `ConnectionManager` does not
 * depend on it directly.
 *
 * Returns, for the given client id, one iterable of member client ids per
 * channel the client is in (the client's own id may be included).
 */
export type ChannelMembersLookup = (
  clientId: string,
) => Iterable<Iterable<string>>;

/** Outcome of {@link ConnectionManager.setNick}. */
export type SetNickResult = "ok" | "in-use";

/** Outcome of {@link ConnectionManager.setUser} and {@link ConnectionManager.acceptPass}. */
export type RegistrationStepResult = "ok" | "already-registered";

export interface BroadcastOptions {
  /** Also deliver to the subject client itself (e.g. `NICK` changes). Default false. */
  readonly includeSelf?: boolean;
}

interface RegistrationState {
  passReceived: boolean;
}

/** Opaque handle returned by {@link TimerApi.setTimeout}. */
export type TimerHandle = unknown;

/** Injectable timer functions so keep-alive can be tested without waiting. */
export interface TimerApi {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export const DEFAULT_IDLE_INTERVAL_MS = 120_000;
export const DEFAULT_PING_TIMEOUT_MS = 60_000;

/** Keep-alive configuration (Req 4.3, 4.4); mirrors `ServerConfig`. */
export interface ConnectionManagerOptions {
  /** Server name used as the prefix and token of server-initiated `PING`. */
  readonly serverName?: string;
  readonly idleIntervalMs?: number;
  readonly pingTimeoutMs?: number;
  readonly timers?: TimerApi;
}

/** Real timers; unref'd so idle keep-alive never holds the process open. */
export const realTimers: TimerApi = {
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    handle.unref();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

interface KeepAliveState {
  idle?: TimerHandle;
  pingTimeout?: TimerHandle;
}

/**
 * Owns all connected clients, the case-mapped nick index and the registration
 * state machine `PASS? -> NICK + USER -> registered` (Req 3).
 */
export class ConnectionManager {
  private readonly byId = new Map<string, Client>();
  /** Keyed by `irc_lower(nick)`; value is the owning client id. */
  private readonly byNick = new Map<string, string>();
  private readonly registration = new Map<string, RegistrationState>();

  private readonly keepAlive = new Map<string, KeepAliveState>();
  private readonly serverName: string;
  private readonly idleIntervalMs: number;
  private readonly pingTimeoutMs: number;
  private readonly timers: TimerApi;

  constructor(
    private readonly channelMembers: ChannelMembersLookup,
    options: ConnectionManagerOptions = {},
  ) {
    this.serverName = options.serverName ?? "seance";
    this.idleIntervalMs = options.idleIntervalMs ?? DEFAULT_IDLE_INTERVAL_MS;
    this.pingTimeoutMs = options.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS;
    this.timers = options.timers ?? realTimers;
  }

  /**
   * Record that a complete message arrived from `client`: cancels any pending
   * ping timeout and restarts the idle timer (Req 4.3). No-op for clients that
   * are not tracked.
   */
  touch(client: Client): void {
    if (this.byId.get(client.id) !== client || client.virtual === true) return;
    this.clearKeepAlive(client.id);
    this.scheduleIdle(client);
  }

  private scheduleIdle(client: Client): void {
    const state: KeepAliveState = this.keepAlive.get(client.id) ?? {};
    this.keepAlive.set(client.id, state);
    state.idle = this.timers.setTimeout(() => {
      state.idle = undefined;
      try {
        client.send({ command: "PING", params: [this.serverName] });
      } catch {
        // A failed send means the connection is already unusable; the
        // ping timeout below closes it.
      }
      state.pingTimeout = this.timers.setTimeout(() => {
        state.pingTimeout = undefined;
        this.keepAlive.delete(client.id);
        client.close("Ping timeout");
      }, this.pingTimeoutMs);
    }, this.idleIntervalMs);
  }

  private clearKeepAlive(id: string): void {
    const state = this.keepAlive.get(id);
    if (state === undefined) return;
    if (state.idle !== undefined) this.timers.clearTimeout(state.idle);
    if (state.pingTimeout !== undefined) this.timers.clearTimeout(state.pingTimeout);
    this.keepAlive.delete(id);
  }

  /** Start tracking a client. Throws if the id is already tracked. */
  add(client: Client): void {
    if (this.byId.has(client.id)) {
      throw new Error(`Cannot add client: id "${client.id}" is already tracked`);
    }
    this.byId.set(client.id, client);
    this.registration.set(client.id, { passReceived: false });
    if (client.nick !== undefined) {
      const key = irc_lower(client.nick);
      if (this.byNick.has(key)) {
        this.byId.delete(client.id);
        this.registration.delete(client.id);
        throw new Error(`Cannot add client "${client.id}": nick "${client.nick}" is in use`);
      }
      this.byNick.set(key, client.id);
    }
    if (client.virtual !== true) this.scheduleIdle(client);
  }

  /**
   * Stop tracking a client and release its nick so it is reusable under
   * rfc1459 case-mapping (Req 11.5). Does not close the connection.
   * Returns false when the id was unknown.
   */
  remove(id: string): boolean {
    const client = this.byId.get(id);
    if (client === undefined) return false;
    this.clearKeepAlive(id);
    if (client.nick !== undefined) {
      const key = irc_lower(client.nick);
      if (this.byNick.get(key) === id) this.byNick.delete(key);
    }
    this.byId.delete(id);
    this.registration.delete(id);
    return true;
  }

  get(id: string): Client | undefined {
    return this.byId.get(id);
  }

  /** Look up a client by nick using rfc1459 case-mapping. */
  getByNick(nick: string): Client | undefined {
    const id = this.byNick.get(irc_lower(nick));
    return id === undefined ? undefined : this.byId.get(id);
  }

  isNickInUse(nick: string): boolean {
    return this.byNick.has(irc_lower(nick));
  }

  get size(): number {
    return this.byId.size;
  }

  /** Snapshot of all tracked clients. */
  clients(): readonly Client[] {
    return [...this.byId.values()];
  }

  /**
   * Record an accepted `PASS`. Returns "already-registered" (-> 462) when the
   * client is already registered; state is left unchanged (Req 3.2).
   */
  acceptPass(client: Client): RegistrationStepResult {
    const state = this.requireState(client);
    if (client.registered) return "already-registered";
    state.passReceived = true;
    return "ok";
  }

  /** True when a `PASS` has been accepted for this client. */
  hasPass(client: Client): boolean {
    return this.requireState(client).passReceived;
  }

  /**
   * Claim `nick` for the client (initial or change). Returns "in-use" when a
   * different client owns a case-mapped equal nick; a case-only change of the
   * client's own nick is allowed. The caller validates the nick syntax.
   */
  setNick(client: Client, nick: string): SetNickResult {
    this.requireState(client);
    const key = irc_lower(nick);
    const owner = this.byNick.get(key);
    if (owner !== undefined && owner !== client.id) return "in-use";
    if (client.nick !== undefined) {
      const oldKey = irc_lower(client.nick);
      if (this.byNick.get(oldKey) === client.id) this.byNick.delete(oldKey);
    }
    this.byNick.set(key, client.id);
    client.nick = nick;
    return "ok";
  }

  /**
   * Record `USER`. Returns "already-registered" (-> 462) when the client is
   * already registered, leaving state unchanged (Req 3.2, 3.8).
   */
  setUser(client: Client, user: string): RegistrationStepResult {
    this.requireState(client);
    if (client.registered) return "already-registered";
    client.user = user;
    return "ok";
  }

  /**
   * Complete registration if `NICK` and `USER` have both been supplied.
   * `requirePass` makes an accepted `PASS` mandatory. Returns true only on the
   * transition to registered, so the caller can send the welcome burst once.
   */
  tryCompleteRegistration(client: Client, requirePass = false): boolean {
    const state = this.requireState(client);
    if (client.registered) return false;
    if (client.nick === undefined || client.user === undefined) return false;
    if (requirePass && !state.passReceived) return false;
    client.registered = true;
    return true;
  }

  /**
   * Send `msg` once to every client sharing at least one channel with
   * `client`. Peers are deduplicated; the subject is excluded unless
   * `includeSelf` is set (Req 3.10, 11.1, 11.2). One failing `send` does not
   * stop delivery to the rest; failures are rethrown together afterwards.
   */
  broadcastToPeers(
    client: Client,
    msg: IrcMessage,
    options: BroadcastOptions = {},
  ): void {
    const recipients = new Set<string>();
    for (const members of this.channelMembers(client.id)) {
      for (const memberId of members) recipients.add(memberId);
    }
    recipients.delete(client.id);
    if (options.includeSelf === true) recipients.add(client.id);

    const errors: unknown[] = [];
    for (const id of recipients) {
      const peer = this.byId.get(id);
      if (peer === undefined) continue;
      try {
        peer.send(msg);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `broadcastToPeers: ${errors.length} of ${recipients.size} deliveries failed`,
      );
    }
  }

  private requireState(client: Client): RegistrationState {
    const state = this.registration.get(client.id);
    if (state === undefined || this.byId.get(client.id) !== client) {
      throw new Error(`Client "${client.id}" is not tracked by this ConnectionManager`);
    }
    return state;
  }
}
