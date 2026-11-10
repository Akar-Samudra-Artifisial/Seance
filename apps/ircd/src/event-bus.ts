import type { IrcMessage } from "@seance/irc-protocol";

/** A channel `PRIVMSG`/`NOTICE` delivered to the channel. */
export type IrcMessageEvent = {
  readonly channel: string;
  /** Nick of the sender. */
  readonly from: string;
  readonly message: IrcMessage;
};

/** A channel mode change (Req 9.10): channel, affected mode, target member. */
export type IrcModeEvent = {
  readonly channel: string;
  /** Nick of the operator who made the change. */
  readonly by: string;
  /** Mode letter without sign: `o`, `v`, `m` or `b`. */
  readonly mode: "o" | "v" | "m" | "b";
  readonly adding: boolean;
  /** Target nick for `o`/`v`; undefined for channel-wide modes such as `m`. */
  readonly target?: string;
};

/** A kick (Req 10.4) so the agent runner can cancel the target's session. */
export type IrcKickEvent = {
  readonly channel: string;
  readonly by: string;
  readonly target: string;
  readonly reason: string;
};

/** An accepted `INVITE` so the agent runner can react to invited agents. */
export type IrcInviteEvent = {
  readonly channel: string;
  /** Nick of the inviting channel member. */
  readonly inviter: string;
  /** Nick of the invited user. */
  readonly target: string;
  /** `irc_lower(target)`: the case-mapped key, so consumers need not re-derive it. */
  readonly targetKey: string;
  /** True when the target is a registered connected client; false for a resolver-claimed nick. */
  readonly targetOnline: boolean;
  /** Event time in epoch milliseconds, from the injectable clock. */
  readonly ts: number;
};

/**
 * A client finished registration (runner-services Req 3): after the welcome burst and MOTD,
 * once per client. Carries no host, user, password or address.
 */
export type IrcRegisterEvent = {
  readonly nick: string;
  /** True for in-process (agent) clients. */
  readonly virtual: boolean;
};

export type EventMap = {
  readonly "irc.invite": IrcInviteEvent;
  readonly "irc.register": IrcRegisterEvent;
  readonly "irc.message": IrcMessageEvent;
  readonly "irc.mode": IrcModeEvent;
  readonly "irc.kick": IrcKickEvent;
};

export type EventName = keyof EventMap;
export type Listener<K extends EventName> = (event: EventMap[K]) => void;
export type Unsubscribe = () => void;

/** Called when a listener throws; receives the event name and the error. */
export type ListenerErrorHandler = (name: EventName, error: unknown) => void;

const defaultErrorHandler: ListenerErrorHandler = (name, error) => {
  console.error(`EventBus listener for "${name}" threw:`, error);
};

/**
 * Typed in-process event bus. Listeners run synchronously in subscription
 * order. A throwing listener never affects the publisher or other listeners;
 * its error is reported to the error handler. In-process only; there is no external broker.
 */
export class EventBus {
  private readonly listeners = new Map<EventName, Set<Listener<never>>>();

  constructor(private readonly onError: ListenerErrorHandler = defaultErrorHandler) {}

  /** Register a listener; the returned function removes it (idempotent). */
  subscribe<K extends EventName>(name: K, listener: Listener<K>): Unsubscribe {
    let set = this.listeners.get(name);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(name, set);
    }
    // Wrap so the same function subscribed twice yields independent entries.
    const entry: Listener<K> = (event) => listener(event);
    set.add(entry as Listener<never>);
    return () => {
      set.delete(entry as Listener<never>);
    };
  }

  publish<K extends EventName>(name: K, event: EventMap[K]): void {
    const set = this.listeners.get(name);
    if (set === undefined) return;
    // Snapshot so (un)subscribing during dispatch is safe.
    for (const listener of [...set] as Listener<K>[]) {
      try {
        listener(event);
      } catch (error) {
        try {
          this.onError(name, error);
        } catch (handlerError) {
          console.error("EventBus error handler threw:", handlerError);
        }
      }
    }
  }
}
