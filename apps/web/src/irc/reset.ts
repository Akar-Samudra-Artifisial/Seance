import { nullRecord } from "./record.js";
import type { ClientState, Window } from "./types.js";

function resetWindow(win: Window): Window {
  // Keep lines and flags; membership and topic come back from the server after re-registration.
  const { topic: _topic, members: _members, modes: _modes, exorcised: _exorcised, ...rest } = win;
  void _topic;
  void _members;
  void _modes;
  void _exorcised;
  return win.kind === "channel" ? { ...rest, members: nullRecord() } : rest;
}

/**
 * State after a reconnect starts: every window keeps its lines, while members, topics,
 * pending WHOIS blocks and NAMES expectations are cleared. Phase becomes `connecting`.
 * Pure: the input is never mutated.
 */
export function resetForReconnect(state: ClientState): ClientState {
  const windows = nullRecord<Window>();
  for (const [key, win] of Object.entries(state.windows)) windows[key] = resetWindow(win);
  return {
    ...state,
    phase: "connecting",
    windows,
    whoisPending: nullRecord(),
    away: nullRecord(),
    expectingNames: [],
    userModes: "",
  };
}
