import { irc_lower } from "./casemap.js";
import { plain } from "./selectors.js";
import { LIST_NAME_MAX, LIST_TOPIC_MAX, NAMES_BATCH_MAX_BYTES } from "./types.js";
import type { ListRow } from "./types.js";

const COUNT_RE = /^\d{1,9}$/;

/**
 * Validate the parameters of a `322` reply (`<me> <channel> <users> :<topic>`). Returns undefined
 * for a reply that must be dropped: bad channel name or user count. The topic is clipped, never trusted.
 */
export function parseListRow(params: readonly string[]): ListRow | undefined {
  const name = params[1];
  const count = params[2];
  if (name === undefined || count === undefined) return undefined;
  // The limit is in UTF-8 bytes, not characters, so one name always fits a NAMES line (<= 512 bytes).
  if (name === "" || utf8Length(name) > LIST_NAME_MAX || /[\s,\x00]/.test(name)) return undefined;
  if (!COUNT_RE.test(count)) return undefined;
  const topic = (params[3] ?? "").slice(0, LIST_TOPIC_MAX);
  return { name, users: Number(count), topic, agents: null };
}

export interface RowFilter {
  /** Matched against channel name and topic, case-insensitive, control codes ignored. */
  readonly text: string;
  /** Rows with a known agent count below this are hidden; unknown counts pass. */
  readonly minAgents: number;
  readonly hideEmptyTopics: boolean;
}

export const NO_FILTER: RowFilter = { text: "", minAgents: 0, hideEmptyTopics: false };

/** Rows that satisfy the filter, in their original order. Pure. */
export function filterRows(rows: readonly ListRow[], filter: RowFilter): readonly ListRow[] {
  const needle = irc_lower(plain(filter.text.trim()));
  return rows.filter((row) => {
    const topic = plain(row.topic);
    if (filter.hideEmptyTopics && topic.trim() === "") return false;
    if (filter.minAgents > 0 && row.agents !== null && row.agents < filter.minAgents) return false;
    if (needle === "") return true;
    return irc_lower(row.name).includes(needle) || irc_lower(topic).includes(needle);
  });
}

export type SortColumn = "channel" | "agents" | "users" | "topic";
export type SortDirection = "asc" | "desc";
export interface SortState {
  readonly column: SortColumn;
  readonly direction: SortDirection;
}

/** Click on a header: ascending, then descending, then back to server order (undefined). */
export function nextSort(current: SortState | undefined, column: SortColumn): SortState | undefined {
  if (current === undefined || current.column !== column) return { column, direction: "asc" };
  return current.direction === "asc" ? { column, direction: "desc" } : undefined;
}

function compare(a: ListRow, b: ListRow, column: SortColumn): number {
  switch (column) {
    case "channel":
      return cmp(irc_lower(a.name), irc_lower(b.name));
    case "topic":
      return cmp(irc_lower(plain(a.topic)), irc_lower(plain(b.topic)));
    case "users":
      return a.users - b.users;
    case "agents":
      return (a.agents ?? 0) - (b.agents ?? 0);
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A sorted copy. Stable: equal keys keep server order. Unknown agent counts sort last in both
 * directions. `undefined` keeps server order. Pure.
 */
export function sortRows(rows: readonly ListRow[], sort: SortState | undefined): readonly ListRow[] {
  if (sort === undefined) return rows;
  const sign = sort.direction === "asc" ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((x, y) => {
      if (sort.column === "agents") {
        const xu = x.row.agents === null;
        const yu = y.row.agents === null;
        if (xu !== yu) return xu ? 1 : -1;
      }
      return sign * compare(x.row, y.row, sort.column) || x.index - y.index;
    })
    .map((e) => e.row);
}

/** UTF-8 byte length of a string (the IRC line limit counts bytes, not characters). */
function utf8Length(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/**
 * Split channel names into `NAMES` parameters (comma lists) so that every `NAMES <list>` line stays
 * within `maxBytes` UTF-8 bytes. Every name appears in exactly one batch, in order. Pure.
 */
export function batchNames(names: readonly string[], maxBytes: number = NAMES_BATCH_MAX_BYTES): readonly string[] {
  const limit = maxBytes - "NAMES ".length;
  const out: string[] = [];
  let current = "";
  for (const name of names) {
    const joined = current === "" ? name : `${current},${name}`;
    if (current !== "" && utf8Length(joined) > limit) {
      out.push(current);
      current = name;
    } else {
      current = joined;
    }
  }
  if (current !== "") out.push(current);
  return out;
}

/** Summary for the dialog footer: channels and the known agents in them. */
export function summarise(rows: readonly ListRow[]): { readonly channels: number; readonly agents: number } {
  return { channels: rows.length, agents: rows.reduce((n, r) => n + (r.agents ?? 0), 0) };
}
