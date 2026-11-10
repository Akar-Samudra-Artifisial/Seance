import { appendLine } from "./buffer.js";
import { channelKey, keyOf, queryKey } from "./casemap.js";
import { GATED_KINDS } from "./classify.js";
import { hasVisibleText } from "./formatter.js";
import { memberPrefix } from "./nick-order.js";
import { getOwn, nullRecord, withEntry, withoutEntry } from "./record.js";
import type { Rec } from "./record.js";
import type {
  ClientState,
  ExorcismParts,
  Line,
  LineKind,
  WhoisPending,
  Window,
  WindowKind,
} from "./types.js";

export const STATUS_KEY = "status";

/** Upper bound for open query windows, remembered closed windows and pending WHOIS blocks. */
export const MAX_QUERIES = 50;
export const MAX_CLOSED = 50;
export const MAX_WHOIS_PENDING = 50;
export const CREDITS_MAX = 50;
/** R8.25: channels kept per agent in `credits`; the oldest written is dropped first. */
export const CREDITS_CHANNELS_MAX = 50;

/** A line to append; id and timestamp are assigned by `appendTo`. */
export interface LineSpec {
  readonly kind: LineKind;
  readonly text: string;
  readonly from?: string;
  readonly exorcism?: ExorcismParts;
  readonly whois?: WhoisPending;
  readonly prefix?: { readonly user: string; readonly host: string };
  readonly code?: string;
  readonly mention?: boolean;
  readonly own?: boolean;
  readonly awayEvent?: "away" | "back";
}

/**
 * `@`, `+` or "" for a message line in a channel window: the sender's mode when the line arrives
 * (Frame_01 shows `<+coder>` before coder got `+o`). Undefined outside channels.
 */
function prefixAtTime(target: Window, spec: LineSpec): string | undefined {
  if (spec.kind !== "message" || spec.from === undefined || target.members === undefined) return undefined;
  const key = keyOf(spec.from);
  const member = Object.hasOwn(target.members, key) ? target.members[key] : undefined;
  return member === undefined ? "" : memberPrefix(member);
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * `--- Session start: Fri Nov 06 23:38:02 2026` (Frame_01 node 1:1352), in the local time zone of
 * the runtime. English names: the format does not follow the browser locale.
 */
export function sessionStartText(nowMs: number): string {
  const d = new Date(nowMs);
  const p = (n: number): string => String(n).padStart(2, "0");
  const day = DAYS[d.getDay()] ?? "";
  const month = MONTHS[d.getMonth()] ?? "";
  const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return `--- Session start: ${day} ${month} ${p(d.getDate())} ${time} ${String(d.getFullYear())}`;
}

/** `user` and `host` of a `nick!user@host` prefix; undefined for server or partial prefixes. */
export function userHostOf(prefix: string | undefined): { readonly user: string; readonly host: string } | undefined {
  if (prefix === undefined) return undefined;
  const bang = prefix.indexOf("!");
  const at = prefix.indexOf("@", bang + 1);
  if (bang === -1 || at === -1) return undefined;
  return { user: prefix.slice(bang + 1, at), host: prefix.slice(at + 1) };
}

export function emptyWindow(key: string, kind: WindowKind, name: string): Window {
  const base: Window = { key, kind, name, lines: [], unread: false, mentioned: false };
  return kind === "channel" ? { ...base, members: nullRecord() } : base;
}

/** Fresh client state. The Status_Window exists from the start and is active. */
export function initialState(ownNick = ""): ClientState {
  return {
    phase: "disconnected",
    ownNick,
    windows: withEntry<Window>(undefined, STATUS_KEY, emptyWindow(STATUS_KEY, "status", "Status")),
    order: [STATUS_KEY],
    activeKey: STATUS_KEY,
    closedLines: nullRecord(),
    whoisPending: nullRecord(),
    silentWhois: [],
    silentMessaged: [],
    silentExpired: [],
    credits: nullRecord(),
    away: nullRecord(),
    nextLineId: 1,
    paste: { queue: [] },
    expectingNames: [],
    expectingModes: [],
    userModes: "",
  };
}

/** Nick part of a `nick!user@host` prefix; "" when there is no prefix. */
export function nickOf(prefix: string | undefined): string {
  if (prefix === undefined) return "";
  const bang = prefix.indexOf("!");
  return bang === -1 ? prefix : prefix.slice(0, bang);
}

/** A prefix without `!` (or no prefix at all) names a server, not a user. */
export function isServerPrefix(prefix: string | undefined): boolean {
  return prefix === undefined || !prefix.includes("!");
}

export function isChannelName(name: string): boolean {
  return name.startsWith("#") || name.startsWith("&");
}

export function isOwnNick(state: ClientState, nick: string): boolean {
  return state.ownNick !== "" && keyOf(nick) === keyOf(state.ownNick);
}

function withWindow(state: ClientState, win: Window): ClientState {
  return { ...state, windows: withEntry(state.windows, win.key, win) };
}

/**
 * Append a line to the window `key`. A missing window falls back to the
 * Status_Window. Non-active windows get `unread` (and `mentioned` for a mention).
 */
export function appendTo(state: ClientState, key: string, spec: LineSpec, nowMs: number): ClientState {
  // R9.2: a chat-like line with nothing visible is never stored (no row, no unread, no sound).
  if (GATED_KINDS.includes(spec.kind) && !hasVisibleText(spec.text)) return state;
  const target = getOwn(state.windows, key) ?? getOwn(state.windows, STATUS_KEY) ?? emptyWindow(STATUS_KEY, "status", "Status");
  const mention = spec.mention === true;
  const nickPrefix = prefixAtTime(target, spec);
  const line: Line = {
    id: state.nextLineId,
    at: nowMs,
    kind: spec.kind,
    text: spec.text,
    mention,
    own: spec.own === true,
    ...(spec.from !== undefined ? { from: spec.from } : {}),
    ...(spec.exorcism !== undefined ? { exorcism: spec.exorcism } : {}),
    ...(spec.whois !== undefined ? { whois: spec.whois } : {}),
    ...(spec.prefix !== undefined ? { prefix: spec.prefix } : {}),
    ...(spec.code !== undefined ? { code: spec.code } : {}),
    ...(nickPrefix !== undefined ? { nickPrefix } : {}),
    ...(spec.awayEvent !== undefined ? { awayEvent: spec.awayEvent } : {}),
  };
  const inactive = target.key !== state.activeKey;
  const updated: Window = {
    ...target,
    lines: appendLine(target.lines, line),
    unread: target.unread || inactive,
    mentioned: target.mentioned || (inactive && mention),
  };
  const order = state.order.includes(updated.key) ? state.order : [...state.order, updated.key];
  return { ...withWindow(state, updated), order, nextLineId: state.nextLineId + 1 };
}

export function appendStatus(state: ClientState, spec: LineSpec, nowMs: number): ClientState {
  return appendTo(state, STATUS_KEY, spec, nowMs);
}

/**
 * Open (or reset, for channels) a window. Lines kept in `closedLines` are restored.
 * A channel window always starts with an empty member set and no topic.
 */
export function openWindow(
  state: ClientState,
  kind: WindowKind,
  name: string,
  activate: boolean,
): ClientState {
  const key = kind === "channel" ? channelKey(name) : queryKey(name);
  const existing = getOwn(state.windows, key);
  const restored = getOwn(state.closedLines, key);
  const lines = existing?.lines ?? restored ?? [];
  const win: Window = { ...emptyWindow(key, kind, name), lines };
  const closedLines = withoutEntry(state.closedLines, key);
  const order = state.order.includes(key) ? state.order : [...state.order, key];
  const next: ClientState = { ...withWindow(state, win), order, closedLines };
  return activate ? { ...next, activeKey: key } : next;
}

export function updateWindow(state: ClientState, key: string, fn: (w: Window) => Window): ClientState {
  const win = getOwn(state.windows, key);
  return win === undefined ? state : withWindow(state, fn(win));
}

/** Number of open query windows. */
export function queryCount(state: ClientState): number {
  let n = 0;
  for (const key of Object.keys(state.windows)) if (getOwn(state.windows, key)?.kind === "query") n++;
  return n;
}

/** Keep at most `max` entries, dropping the oldest inserted first. */
export function capRecord<T>(rec: Rec<T>, max: number): Rec<T> {
  const keys = Object.keys(rec);
  if (keys.length <= max) return rec;
  const next = nullRecord<T>();
  for (const k of keys.slice(keys.length - max)) next[k] = rec[k] as T;
  return next;
}

/** Remember the lines of a closed window, bounded by MAX_CLOSED. */
export function rememberClosed(state: ClientState, key: string, lines: Window["lines"]): Rec<Window["lines"]> {
  return capRecord(withEntry(withoutEntry(state.closedLines, key), key, lines), MAX_CLOSED);
}
