import type { IrcMessage } from "@seance/irc-protocol";
import { batchNames, parseListRow } from "./channel-list.js";
import { channelKey } from "./casemap.js";
import { isKnownAgent } from "./classify.js";
import { getOwn, nullRecord } from "./record.js";
import { parseNames } from "./reducer.members.js";
import { LIST_ROWS_MAX } from "./types.js";
import type { ChannelList, ClientState, ListRow } from "./types.js";

/** State with a fresh, loading channel list. The Store sends `LIST` after calling this. */
export function startList(state: ClientState, nowMs: number): ClientState {
  const list: ChannelList = {
    status: "loading",
    rows: [],
    truncated: false,
    requestedAt: nowMs,
    pendingNames: [],
    counting: nullRecord<number>(),
  };
  return { ...state, list };
}

/** The list timed out: keep the rows that arrived and mark the list failed. */
export function failList(state: ClientState): ClientState {
  if (state.list === undefined || state.list.status !== "loading") return state;
  return { ...state, list: { ...state.list, status: "failed", pendingNames: [], counting: nullRecord<number>() } };
}

/** Drop the list (reconnect). */
export function clearList(state: ClientState): ClientState {
  if (state.list === undefined) return state;
  const { list: _dropped, ...rest } = state;
  void _dropped;
  return rest;
}

export interface ListStep {
  readonly state: ClientState;
  readonly send: readonly IrcMessage[];
}

/**
 * 321, 322 and 323 while a list request is loading. Returns undefined when the message is not
 * for the list (no request is loading); the caller then keeps the Status_Window behaviour.
 */
export function onListReply(state: ClientState, msg: IrcMessage, nowMs: number): ListStep | undefined {
  const list = state.list;
  if (list === undefined || list.status !== "loading") return undefined;
  switch (msg.command) {
    case "321":
      return { state, send: [] };
    case "322": {
      const row = parseListRow(msg.params);
      if (row === undefined) return { state, send: [] };
      // A repeated channel (same channelKey) keeps its first row: one row per channel in the dialog.
      const key = channelKey(row.name);
      if (list.rows.some((r) => channelKey(r.name) === key)) return { state, send: [] };
      if (list.rows.length >= LIST_ROWS_MAX) return { state: { ...state, list: { ...list, truncated: true } }, send: [] };
      return { state: { ...state, list: { ...list, rows: [...list.rows, row] } }, send: [] };
    }
    case "323":
      return finishList(state, list, nowMs);
    default:
      return undefined;
  }
}

function agentsOf(state: ClientState, name: string): number | null {
  const win = getOwn(state.windows, channelKey(name));
  if (win === undefined || win.members === undefined) return null;
  return Object.values(win.members).filter((m) => isKnownAgent(m.nick)).length;
}

function finishList(state: ClientState, list: ChannelList, nowMs: number): ListStep {
  const pending: string[] = [];
  const names: string[] = [];
  const rows: ListRow[] = list.rows.map((row) => {
    const known = agentsOf(state, row.name);
    if (known !== null) return { ...row, agents: known };
    pending.push(channelKey(row.name));
    names.push(row.name);
    return row;
  });
  const counting = nullRecord<number>();
  for (const key of pending) counting[key] = 0;
  const next: ChannelList = { ...list, status: "ready", rows, listedAt: nowMs, pendingNames: pending, counting };
  const send = batchNames(names).map((batch): IrcMessage => ({ command: "NAMES", params: [batch] }));
  return { state: { ...state, list: next }, send };
}

/** A `353` for a channel the list is counting: add its Known_Agents. Other replies pass through unchanged. */
export function countListNames(state: ClientState, msg: IrcMessage): ClientState {
  const list = state.list;
  const channel = msg.params[2];
  if (list === undefined || channel === undefined) return state;
  const key = channelKey(channel);
  if (!list.pendingNames.includes(key)) return state;
  const added = parseNames(msg.params[3] ?? "").filter((m) => isKnownAgent(m.nick)).length;
  const counting = nullRecord<number>();
  Object.assign(counting, list.counting);
  counting[key] = (list.counting[key] ?? 0) + added;
  return { ...state, list: { ...list, counting } };
}

/** A `366` for a channel the list is counting: the count is final. */
export function finishListNames(state: ClientState, msg: IrcMessage): ClientState {
  const list = state.list;
  const channel = msg.params[1];
  if (list === undefined || channel === undefined) return state;
  const key = channelKey(channel);
  if (!list.pendingNames.includes(key)) return state;
  const total = list.counting[key] ?? 0;
  const rows = list.rows.map((row) => (channelKey(row.name) === key ? { ...row, agents: total } : row));
  const counting = nullRecord<number>();
  for (const [k, v] of Object.entries(list.counting)) if (k !== key) counting[k] = v;
  return {
    ...state,
    list: { ...list, rows, pendingNames: list.pendingNames.filter((k) => k !== key), counting },
  };
}
