import type { IrcMessage } from "@seance/irc-protocol";
import { keyOf } from "./casemap.js";
import { getOwn, withEntry, withoutEntry } from "./record.js";
import { MAX_WHOIS_PENDING, appendStatus, appendTo, capRecord } from "./reducer.route.js";
import type { ClientState, WhoisPending } from "./types.js";

/** Numerics whose replies are collected into `whoisPending`. */
export const WHOIS_COLLECT = new Set(["311", "319", "312", "320", "317", "301"]);

const ERROR_NUMERIC = /^[45]\d\d$/;

/** `432` / `433` / `464` while registering belong to the Store (`connectError`); they set no line. */
const REGISTRATION_ERRORS = new Set(["432", "433", "464"]);

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
  const existing = getOwn(state.whoisPending, key);
  if (existing === undefined && msg.command === "301") {
    return appendTo(state, state.activeKey, { kind: "numeric", text: `${nick} is away: ${msg.params[2] ?? ""}` }, nowMs);
  }
  const updated = applyReply(existing ?? blankPending(nick), msg);
  const pending = withEntry(existing === undefined ? state.whoisPending : withoutEntry(state.whoisPending, key), key, updated);
  return { ...state, whoisPending: capRecord(pending, MAX_WHOIS_PENDING) };
}

/** 318: emit the grouped block into the Active_Window and drop the collected data. */
export function onEndOfWhois(state: ClientState, msg: IrcMessage, nowMs: number): ClientState {
  const nick = msg.params[1];
  if (nick === undefined || nick === "") return state;
  const key = keyOf(nick);
  const pending = getOwn(state.whoisPending, key);
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
  let base = state;
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
