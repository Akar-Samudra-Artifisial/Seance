import type { IrcMessage } from "@seance/irc-protocol";
import { keyOf } from "./casemap.js";
import { getOwn, nullRecord, withEntry, withoutEntry } from "./record.js";
import { parseCreditsLine } from "./credits.js";
import {
  CREDITS_CHANNELS_MAX,
  CREDITS_MAX,
  MAX_WHOIS_PENDING,
  appendStatus,
  appendTo,
  capRecord,
} from "./reducer.route.js";
import type { ClientState, WhoisPending } from "./types.js";

/** Numerics whose replies are collected into `whoisPending`. */
export const WHOIS_COLLECT = new Set(["311", "319", "312", "320", "317", "301"]);

const ERROR_NUMERIC = /^[45]\d\d$/;

/** `432` / `433` / `464` while registering belong to the Store (`connectError`); they set no line. */
const REGISTRATION_ERRORS = new Set(["432", "433", "464"]);

/** Errors a WHOIS can get: 401 ERR_NOSUCHNICK, 402 ERR_NOSUCHSERVER, 406 ERR_WASNOSUCHNICK. */
const SILENT_ERRORS = new Set(["401", "402", "406"]);

/**
 * Ends the silent WHOIS for `key`: the entry, its "messaged" mark and the replies collected for it go,
 * nothing is printed. Used for 318, a swallowed error and the Store's timeout (R8.22).
 */
export function endSilentWhois(state: ClientState, key: string): ClientState {
  if (!state.silentWhois.includes(key)) return state;
  return {
    ...state,
    whoisPending: withoutEntry(state.whoisPending, key),
    silentWhois: state.silentWhois.filter((k) => k !== key),
    silentMessaged: state.silentMessaged.filter((k) => k !== key),
  };
}

/**
 * R8.23: the user sent a PRIVMSG or NOTICE to `key` while its silent WHOIS is in flight, or after it
 * timed out (its late error may then answer the user).
 */
export function markSilentMessaged(state: ClientState, key: string): ClientState {
  const tracked = state.silentWhois.includes(key) || state.silentExpired.includes(key);
  if (!tracked || state.silentMessaged.includes(key)) return state;
  return { ...state, silentMessaged: [...state.silentMessaged, key] };
}

/**
 * R8.24: the Store's timeout ended the silent WHOIS for `key` without an answer. Like
 * {@link endSilentWhois}, but the key is remembered in `silentExpired` (oldest dropped at the cap), so
 * late replies are not taken for a user WHOIS. The "messaged" mark stays for a late error.
 */
export function expireSilentWhois(state: ClientState, key: string): ClientState {
  if (!state.silentWhois.includes(key)) return state;
  const expired = [...state.silentExpired.filter((k) => k !== key), key].slice(-MAX_WHOIS_PENDING);
  return {
    ...state,
    whoisPending: withoutEntry(state.whoisPending, key),
    silentWhois: state.silentWhois.filter((k) => k !== key),
    silentExpired: expired,
  };
}

/** R8.24: the user asked for this WHOIS: the timed-out silent request no longer filters its replies. */
export function forgetSilentExpired(state: ClientState, nick: string): ClientState {
  const key = keyOf(nick);
  if (!state.silentExpired.includes(key)) return state;
  return {
    ...state,
    silentExpired: state.silentExpired.filter((k) => k !== key),
    silentMessaged: state.silentMessaged.filter((k) => k !== key),
  };
}

/** True when `nick`'s late replies belong to a timed-out silent WHOIS (R8.24). */
export function isSilentExpired(state: ClientState, nick: string | undefined): boolean {
  return nick !== undefined && nick !== "" && state.silentExpired.includes(keyOf(nick));
}

/** Ends a timed-out entry on its late 318 or error: nothing is printed. */
function endSilentExpired(state: ClientState, key: string): ClientState {
  return {
    ...state,
    silentExpired: state.silentExpired.filter((k) => k !== key),
    silentMessaged: state.silentMessaged.filter((k) => k !== key),
  };
}

/**
 * Store side of R8.18: record a silent WHOIS for `nick` (the Store sends the line). Capped at
 * MAX_WHOIS_PENDING; returns the state unchanged when the nick is already silent or the cap is reached.
 */
export function beginSilentWhois(state: ClientState, nick: string): ClientState {
  const key = keyOf(nick);
  if (state.silentWhois.includes(key) || state.silentWhois.length >= MAX_WHOIS_PENDING) return state;
  return { ...state, silentWhois: [...state.silentWhois, key] };
}

/**
 * The user asked for the same WHOIS: the in-flight silent request becomes the user's, so its replies
 * print as the normal block at 318 (the user request wins and nothing prints twice).
 */
export function claimSilentWhois(state: ClientState, nick: string): ClientState {
  const key = keyOf(nick);
  if (!state.silentWhois.includes(key)) return state;
  // The collected replies stay: they become the user's block.
  return {
    ...state,
    silentWhois: state.silentWhois.filter((k) => k !== key),
    silentMessaged: state.silentMessaged.filter((k) => k !== key),
  };
}

/** True for `4xx` / `5xx` command names. */
export function isErrorNumeric(command: string): boolean {
  return ERROR_NUMERIC.test(command);
}

/** Text of a numeric reply without the leading own-nick parameter. */
function textOf(msg: IrcMessage): string {
  return msg.params.slice(1).join(" ");
}

function parseCount(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d{1,15}$/.test(raw)) return undefined;
  return Number(raw);
}

function applyReply(pending: WhoisPending, msg: IrcMessage): WhoisPending {
  const p = msg.params;
  switch (msg.command) {
    case "311":
      return { ...pending, user: { user: p[2] ?? "", host: p[3] ?? "", realname: p[5] ?? "" } };
    case "312":
      return { ...pending, server: { name: p[2] ?? "", info: p[3] ?? "" } };
    case "319": {
      const names = (p[2] ?? "").split(" ").filter((c) => c !== "");
      return { ...pending, channels: [...pending.channels, ...names] };
    }
    case "320":
      return { ...pending, special: [...pending.special, p[2] ?? ""] };
    case "317": {
      const seconds = parseCount(p[2]);
      const signon = parseCount(p[3]);
      if (seconds === undefined || signon === undefined) return pending;
      return { ...pending, idle: { seconds, signon } };
    }
    case "301":
      return { ...pending, away: p[2] ?? "" };
    default:
      return pending;
  }
}

function blankPending(nick: string): WhoisPending {
  return { nick, channels: [], special: [] };
}

function whoisSummary(w: WhoisPending): string {
  const real = w.user?.realname;
  return real === undefined || real === "" ? `${w.nick}` : `${w.nick} (${real})`;
}

/**
 * 311/319/312/320/317 are collected per nick (key = irc_lower). 301 is collected
 * only when a WHOIS is pending for that nick; otherwise it is a plain away reply
 * to a PRIVMSG and shows as a line in the Active_Window.
 */
export function onWhoisReply(state: ClientState, msg: IrcMessage, nowMs: number): ClientState {
  const nick = msg.params[1];
  if (nick === undefined || nick === "") return appendStatus(state, { kind: "numeric", text: textOf(msg) }, nowMs);
  const key = keyOf(nick);
  // R8.24: a late reply to a timed-out silent WHOIS. Only its credits line counts; nothing is
  // collected, so its 318 cannot print a block nobody asked for.
  if (state.silentExpired.includes(key)) {
    if (msg.command !== "320") return state;
    return withCreditsLine(state, key, msg.params[2]);
  }
  const existing = getOwn(state.whoisPending, key);
  // A 301 for a nick with a silent WHOIS belongs to that WHOIS, never a visible away line (R8.18).
  if (existing === undefined && msg.command === "301" && !state.silentWhois.includes(key)) {
    return appendTo(state, state.activeKey, { kind: "numeric", text: `${nick} is away: ${msg.params[2] ?? ""}` }, nowMs);
  }
  const updated = applyReply(existing ?? blankPending(nick), msg);
  const pending = withEntry(existing === undefined ? state.whoisPending : withoutEntry(state.whoisPending, key), key, updated);
  const next = { ...state, whoisPending: capRecord(pending, MAX_WHOIS_PENDING) };
  if (msg.command !== "320") return next;
  return withCreditsLine(next, key, msg.params[2]);
}

/**
 * R8.25: a `320` credits line stores the `used` amount of that agent in that channel (the number
 * after the channel); the lifetime `total` is not kept. Both levels are null-prototype records keyed
 * by irc_lower, capped at CREDITS_MAX agents and CREDITS_CHANNELS_MAX channels per agent, the oldest
 * written first to go. Anything that is not a strict credits line leaves the state alone.
 */
export function withCreditsLine(state: ClientState, agentKey: string, text: string | undefined): ClientState {
  const parsed = parseCreditsLine(text ?? "");
  if (parsed === undefined) return state;
  const channelKey = keyOf(parsed.channel);
  const channels = getOwn(state.credits, agentKey) ?? nullRecord<number>();
  const updatedChannels = capRecord(
    withEntry(withoutEntry(channels, channelKey), channelKey, parsed.used),
    CREDITS_CHANNELS_MAX,
  );
  const agents = capRecord(
    withEntry(withoutEntry(state.credits, agentKey), agentKey, updatedChannels),
    CREDITS_MAX,
  );
  return { ...state, credits: agents };
}

/** 318: emit the grouped block into the Active_Window and drop the collected data. */
export function onEndOfWhois(state: ClientState, msg: IrcMessage, nowMs: number): ClientState {
  const nick = msg.params[1];
  if (nick === undefined || nick === "") return state;
  const key = keyOf(nick);
  const pending = getOwn(state.whoisPending, key);
  // R8.18: a silent WHOIS ends here without a line; its 320 already updated the credits.
  if (state.silentWhois.includes(key)) return endSilentWhois(state, key);
  if (state.silentExpired.includes(key)) return endSilentExpired(state, key);
  // After a 401 there is nothing pending: the error line already replaced the block.
  if (pending === undefined) return state;
  const rest = withoutEntry(state.whoisPending, key);
  return appendTo(
    { ...state, whoisPending: rest },
    state.activeKey,
    { kind: "whois", text: whoisSummary(pending), whois: pending },
    nowMs,
  );
}

/** 322 rows and the 323 terminator go to the Status_Window. */
export function onList(state: ClientState, msg: IrcMessage, nowMs: number): ClientState {
  if (msg.command === "323") {
    return appendStatus(state, { kind: "numeric", text: msg.params[1] ?? "End of /LIST" }, nowMs);
  }
  const channel = msg.params[1] ?? "";
  const count = msg.params[2] ?? "0";
  const topic = msg.params[3] ?? "";
  const text = topic === "" ? `${channel} ${count}` : `${channel} ${count} ${topic}`;
  return appendStatus(state, { kind: "numeric", text }, nowMs);
}

/**
 * 4xx/5xx: shown as an error line in the Active_Window. `401` for a nick with a
 * pending WHOIS discards the collected replies (the error replaces the block).
 */
export function onErrorNumeric(state: ClientState, msg: IrcMessage, nowMs: number): ClientState {
  if (state.phase === "registering" && REGISTRATION_ERRORS.has(msg.command)) return state;
  // R8.18: an error a WHOIS can get (no such nick or server, was no such nick) ends a silent one
  // without a line, for example when the agent has quit since.
  const target = msg.params[1];
  let base = state;
  if (SILENT_ERRORS.has(msg.command) && target !== undefined && state.silentWhois.includes(keyOf(target))) {
    const key = keyOf(target);
    const messaged = state.silentMessaged.includes(key);
    base = endSilentWhois(state, key);
    // R8.23: after a user PRIVMSG or NOTICE to that nick the error may answer the user: show it.
    if (!messaged) return base;
    return appendTo(base, base.activeKey, { kind: "error", text: textOf(msg) }, nowMs);
  }
  // R8.24: the late error of a timed-out silent WHOIS ends it; R8.23 still applies.
  if (SILENT_ERRORS.has(msg.command) && target !== undefined && state.silentExpired.includes(keyOf(target))) {
    const key = keyOf(target);
    const messaged = state.silentMessaged.includes(key);
    base = endSilentExpired(state, key);
    if (!messaged) return base;
    return appendTo(base, base.activeKey, { kind: "error", text: textOf(msg) }, nowMs);
  }
  if (msg.command === "401") {
    const nick = msg.params[1];
    if (nick !== undefined) {
      const key = keyOf(nick);
      if (getOwn(state.whoisPending, key) !== undefined) {
        base = { ...state, whoisPending: withoutEntry(state.whoisPending, key) };
      }
    }
  }
  return appendTo(base, base.activeKey, { kind: "error", text: textOf(msg) }, nowMs);
}
