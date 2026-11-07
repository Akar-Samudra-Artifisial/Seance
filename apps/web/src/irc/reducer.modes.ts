import type { IrcMessage } from "@seance/irc-protocol";
import { channelKey } from "./casemap.js";
import { getOwn } from "./record.js";
import { isChannelName, isOwnNick, updateWindow } from "./reducer.route.js";
import type { ClientState } from "./types.js";

/** Channel modes that take a parameter or name a member; they never enter `modes`. */
const ARGUMENT_FLAGS = new Set(["o", "v", "b", "k", "l", "e", "I"]);

const LETTER = /^[A-Za-z]$/;

/** Render a flag set as `+abc` (sorted by code point); "" when the set is empty. */
function render(flags: ReadonlySet<string>): string {
  return flags.size === 0 ? "" : `+${[...flags].sort().join("")}`;
}

function flagsOf(modes: string | undefined): Set<string> {
  const out = new Set<string>();
  if (modes === undefined) return out;
  for (const ch of modes) if (LETTER.test(ch)) out.add(ch);
  return out;
}

/** True when `text` starts with a sign, i.e. looks like a mode string. */
function isModeString(text: string | undefined): text is string {
  return text !== undefined && (text.startsWith("+") || text.startsWith("-"));
}

/**
 * Apply a mode string such as `+mn-t` to the current flag string. Flags that take
 * arguments are skipped; non-letters are ignored. A string without a leading sign
 * is malformed and returns `current` unchanged. Result is sorted and deduplicated.
 */
export function applyFlagChanges(current: string, modeString: string, exclude: ReadonlySet<string> = ARGUMENT_FLAGS): string {
  if (!isModeString(modeString)) return current;
  const flags = flagsOf(current);
  let adding = true;
  for (const ch of modeString) {
    if (ch === "+") adding = true;
    else if (ch === "-") adding = false;
    else if (LETTER.test(ch) && !exclude.has(ch)) {
      if (adding) flags.add(ch);
      else flags.delete(ch);
    }
  }
  return render(flags);
}

/** Flags of a full mode report (`324`, `221`): replaces the previous value. */
export function flagsFromReport(modeString: string | undefined, exclude: ReadonlySet<string> = ARGUMENT_FLAGS): string | undefined {
  if (!isModeString(modeString)) return undefined;
  return applyFlagChanges("", modeString, exclude);
}

/** User modes take no arguments, so nothing is excluded. */
const NO_EXCLUDE: ReadonlySet<string> = new Set();

/**
 * 324 RPL_CHANNELMODEIS `<me> <channel> <modes> [args]`. Returns `undefined` when the
 * reply is malformed or names a channel that is not open, so the caller can fall back.
 */
export function onChannelModeReply(state: ClientState, msg: IrcMessage): ClientState | undefined {
  const channel = msg.params[1];
  const flags = flagsFromReport(msg.params[2]);
  if (channel === undefined || flags === undefined || !isChannelName(channel)) return undefined;
  const key = channelKey(channel);
  if (getOwn(state.windows, key)?.kind !== "channel") return state;
  return updateWindow(state, key, (w) => ({ ...w, modes: flags }));
}

/** 221 RPL_UMODEIS `<me> <modes>`. Returns `undefined` when malformed. */
export function onUserModeReply(state: ClientState, msg: IrcMessage): ClientState | undefined {
  const flags = flagsFromReport(msg.params[1], NO_EXCLUDE);
  if (flags === undefined) return undefined;
  return { ...state, userModes: flags };
}

/** Channel `MODE`: update `modes` of an open channel window; other windows are untouched. */
export function applyChannelModeChange(state: ClientState, channel: string, modeString: string): ClientState {
  const key = channelKey(channel);
  if (getOwn(state.windows, key)?.kind !== "channel") return state;
  return updateWindow(state, key, (w) => ({ ...w, modes: applyFlagChanges(w.modes ?? "", modeString) }));
}

/** `MODE <ownnick> <modes>`: update `userModes`. Another nick's modes are ignored. */
export function applyUserModeChange(state: ClientState, target: string, modeString: string): ClientState {
  if (!isOwnNick(state, target)) return state;
  return { ...state, userModes: applyFlagChanges(state.userModes, modeString, NO_EXCLUDE) };
}
