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
/** `hh:mm:ss` for a non-negative duration in ms (hours are not capped at 24). */
export function goneText(ms: number): string {
  const total = Math.floor((Number.isFinite(ms) && ms > 0 ? ms : 0) / 1000);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(Math.floor(total / 3600))}:${p(Math.floor(total / 60) % 60)}:${p(total % 60)}`;
}

/**
 * Time of the latest `is away (…)` line of `nick` in any open window, or undefined when none is
 * kept (the away mark came from `301`, or the line left the buffer). Only lines written by
 * `onInboundAway` count (`awayEvent`), so a user's `/me is away (…)` cannot fake the start.
 */
function awaySinceOf(state: ClientState, nick: string): number | undefined {
  const key = keyOf(nick);
  let since: number | undefined;
  for (const winKey of state.order) {
    const lines = getOwn(state.windows, winKey)?.lines ?? [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (l?.awayEvent === undefined || l.from === undefined || keyOf(l.from) !== key) continue;
      if (l.awayEvent === "away" && (since === undefined || l.at > since)) since = l.at;
      break;
    }
  }
  return since;
}

export function onInboundAway(state: ClientState, msg: IrcMessage, nowMs: number): ClientState {
  const nick = nickOf(msg.prefix);
  if (nick === "") return state;
  const text = msg.params[0] ?? "";
  const away = text !== "";
  // Frame_01 node 1:1368: `coder is back (gone 00:01:48)` when the away start is known.
  const since = away || !hasOwnKey(state.away, keyOf(nick)) ? undefined : awaySinceOf(state, nick);
  let next = away ? markAway(state, nick, text) : clearAway(state, nick);
  const line = away ? `is away (${text})` : since === undefined ? "is back" : `is back (gone ${goneText(nowMs - since)})`;
  for (const key of next.order) {
    const win = getOwn(next.windows, key);
    if (win?.kind !== "channel" || win.members === undefined || !hasMember(win.members, nick)) continue;
    next = appendTo(next, key, { kind: "action", from: nick, text: line, awayEvent: away ? "away" : "back" }, nowMs);
  }
  return next;
}
