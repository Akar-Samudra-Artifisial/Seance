import type { IrcMessage } from "@seance/irc-protocol";
import { keyOf } from "./casemap.js";
import { getOwn, hasOwnKey, withEntry, withoutEntry } from "./record.js";
import { appendTo, capRecord, nickOf } from "./reducer.route.js";
import { hasMember } from "./reducer.members.js";
import type { ClientState } from "./types.js";

/** Upper bound for the `away` record; the oldest mark is dropped first. */
export const AWAY_MAX = 200;

/** Mark `nick` as away with `text` (may be empty). Re-marking moves the entry to the newest slot. */
export function markAway(state: ClientState, nick: string, text: string): ClientState {
  const key = keyOf(nick);
  const base = withoutEntry(state.away, key);
  return { ...state, away: capRecord(withEntry(base, key, text), AWAY_MAX) };
}

export function clearAway(state: ClientState, nick: string): ClientState {
  const key = keyOf(nick);
  return hasOwnKey(state.away, key) ? { ...state, away: withoutEntry(state.away, key) } : state;
}

/** NICK: the mark follows the nick. */
export function moveAway(state: ClientState, from: string, to: string): ClientState {
  const text = getOwn(state.away, keyOf(from));
  if (text === undefined) return state;
  return markAway(clearAway(state, from), to, text);
}

/** QUIT: the mark is dropped. */
export function dropAway(state: ClientState, nick: string): ClientState {
  return clearAway(state, nick);
}

/** 301 RPL_AWAY: `<me> <nick> :<text>`. Marks the nick; the caller still routes the reply. */
export function onAwayReply(state: ClientState, msg: IrcMessage): ClientState {
  const nick = msg.params[1];
  if (nick === undefined || nick === "") return state;
  return markAway(state, nick, msg.params[2] ?? "");
}

/** 305 RPL_UNAWAY / 306 RPL_NOWAWAY concern the own nick. */
export function onSelfAway(state: ClientState, msg: IrcMessage): ClientState {
  if (state.ownNick === "") return state;
  return msg.command === "306" ? markAway(state, state.ownNick, "") : clearAway(state, state.ownNick);
}

/**
 * Inbound `:nick!u@h AWAY [:text]`. Updates the mark and writes an action-style line
 * to every open channel that holds the member. Messages without a nick are ignored.
 */
export function onInboundAway(state: ClientState, msg: IrcMessage, nowMs: number): ClientState {
  const nick = nickOf(msg.prefix);
  if (nick === "") return state;
  const text = msg.params[0] ?? "";
  const away = text !== "";
  let next = away ? markAway(state, nick, text) : clearAway(state, nick);
  const line = away ? `is away (${text})` : "is back";
  for (const key of next.order) {
    const win = getOwn(next.windows, key);
    if (win?.kind !== "channel" || win.members === undefined || !hasMember(win.members, nick)) continue;
    next = appendTo(next, key, { kind: "action", from: nick, text: line }, nowMs);
  }
  return next;
}
