import { HISTORY_MAX } from "./types.js";

/**
 * Command history for the Input_Line (R7.23). Immutable: every function returns a new value.
 * `entries` is oldest first. `position === entries.length` is the draft position, where the
 * Input_Line shows the text the user was typing before pressing `Up`.
 */
export interface History {
  readonly entries: readonly string[];
  readonly position: number;
  readonly draft: string;
}

export interface NavigateResult {
  readonly history: History;
  /** Text the Input_Line must show after the move. */
  readonly text: string;
}

export type HistoryDirection = "up" | "down";

export const EMPTY_HISTORY: History = { entries: [], position: 0, draft: "" };

/**
 * Append a submitted entry. Empty entries and a repeat of the newest entry are skipped.
 * Keeps at most HISTORY_MAX entries (the oldest are dropped) and returns to the draft position.
 */
export function pushHistory(history: History, entry: string): History {
  const last = history.entries[history.entries.length - 1];
  if (entry === "" || entry === last) {
    return { entries: history.entries, position: history.entries.length, draft: "" };
  }
  const entries = [...history.entries, entry].slice(-HISTORY_MAX);
  return { entries, position: entries.length, draft: "" };
}

/**
 * Move through the history. `current` is the Input_Line content, saved as the draft when
 * leaving the draft position. `Up` stops at the oldest entry; `Down` past the newest entry
 * restores the draft.
 */
export function navigate(
  history: History,
  direction: HistoryDirection,
  current: string,
): NavigateResult {
  const { entries } = history;
  const atDraft = history.position >= entries.length;

  if (direction === "up") {
    if (entries.length === 0) return { history, text: current };
    const draft = atDraft ? current : history.draft;
    const position = Math.max(0, Math.min(history.position, entries.length) - 1);
    return { history: { entries, position, draft }, text: entries[position] ?? current };
  }

  if (atDraft) return { history, text: current };
  const position = history.position + 1;
  if (position >= entries.length) {
    return { history: { entries, position: entries.length, draft: history.draft }, text: history.draft };
  }
  return { history: { entries, position, draft: history.draft }, text: entries[position] ?? current };
}
