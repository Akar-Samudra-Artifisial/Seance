import type { IrcMessage } from "@seance/irc-protocol";
import { channelKey, keyOf, queryKey } from "./casemap.js";
import { getOwn, withEntry, withoutEntry } from "./record.js";
import { classifyLine } from "./classify.js";
import { isMention } from "./mention.js";
import {
  addMember,
  applyModes,
  hasMember,
  mergeMembers,
  parseNames,
  removeMember,
  renameMember,
} from "./reducer.members.js";
import {
  MAX_QUERIES,
  appendStatus,
  appendTo,
  isChannelName,
  isOwnNick,
  isServerPrefix,
  nickOf,
  openWindow,
  queryCount,
  rememberClosed,
  sessionStartText,
  updateWindow,
  userHostOf,
} from "./reducer.route.js";
import { dropAway, moveAway, onAwayReply, onInboundAway, onSelfAway } from "./reducer.away.js";
import {
  applyChannelModeChange,
  applyUserModeChange,
  onChannelModeReply,
  onUserModeReply,
} from "./reducer.modes.js";
import { isErrorNumeric, onEndOfWhois, onErrorNumeric, onList, onWhoisReply } from "./reducer.whois.js";
import { exorcismText } from "./selectors.js";
import { EXORCISED_MAX } from "./types.js";
import type { ClientState, Window } from "./types.js";

export { initialState } from "./reducer.route.js";

export interface ReduceResult {
  readonly state: ClientState;
  /** Messages the Store must send, in order (PONG, nothing else in M2). */
  readonly send: readonly IrcMessage[];
  /** True when a line flagged as Mention was appended. */
  readonly mention: boolean;
  /** Token (last parameter) of an inbound PONG; the Store matches it against its lag ping. */
  readonly pong?: string;
}

const NUMERIC = /^\d{3}$/;
const ACTION = /^\x01ACTION ?([^\x01]*)\x01?$/;

function done(state: ClientState, mention = false, send: readonly IrcMessage[] = []): ReduceResult {
  return { state, send, mention };
}

/** Text of a numeric reply without the leading own-nick parameter. */
function numericText(msg: IrcMessage): string {
  return msg.params.slice(1).join(" ");
}

function statusLine(state: ClientState, msg: IrcMessage, nowMs: number): ReduceResult {
  const numeric = NUMERIC.test(msg.command);
  const text = numeric ? numericText(msg) : [msg.command, ...msg.params].join(" ");
  const kind = msg.command === "372" || msg.command === "375" || msg.command === "376" ? "motd" : "numeric";
  return done(
    appendStatus(state, { kind: numeric ? kind : "system", text, ...(numeric ? { code: msg.command } : {}) }, nowMs),
  );
}

function onWelcome(state: ClientState, msg: IrcMessage, nowMs: number): ReduceResult {
  const nick = msg.params[0];
  const base: ClientState = {
    ...state,
    phase: "registered",
    ownNick: nick !== undefined && nick !== "" ? nick : state.ownNick,
    ...(msg.prefix !== undefined ? { server: msg.prefix } : {}),
  };
  const session = appendStatus(base, { kind: "system", text: sessionStartText(nowMs) }, nowMs);
  return done(appendStatus(session, { kind: "numeric", text: msg.params[1] ?? "", code: "001" }, nowMs));
}

/** `{ prefix }` for a line spec when the message carries `nick!user@host`. */
function prefixSpec(msg: IrcMessage): { readonly prefix?: { readonly user: string; readonly host: string } } {
  const prefix = userHostOf(msg.prefix);
  return prefix === undefined ? {} : { prefix };
}

function withoutExorcised(w: Window, nick: string): Window {
  if (w.exorcised === undefined) return w;
  const kept = w.exorcised.filter((n) => keyOf(n) !== keyOf(nick));
  return kept.length === w.exorcised.length ? w : { ...w, exorcised: kept };
}

function withExorcised(w: Window, nick: string): Window {
  const list = [...(withoutExorcised(w, nick).exorcised ?? []), nick];
  return { ...w, exorcised: list.slice(-EXORCISED_MAX) };
}

function onJoin(state: ClientState, msg: IrcMessage, nowMs: number): ReduceResult {
  const channel = msg.params[0];
  const nick = nickOf(msg.prefix);
  if (channel === undefined || nick === "") return statusLine(state, msg, nowMs);
  const key = channelKey(channel);
  if (isOwnNick(state, nick)) {
    const isNew = getOwn(state.windows, key) === undefined;
    const opened = openWindow(state, "channel", channel, true);
    const withSession = isNew
      ? appendTo(opened, key, { kind: "system", text: sessionStartText(nowMs) }, nowMs)
      : opened;
    return done(
      appendTo(withSession, key, { kind: "join", text: `Now talking in ${channel}`, ...prefixSpec(msg) }, nowMs),
    );
  }
  if (getOwn(state.windows, key) === undefined) return done(state);
  const withMember = updateWindow(state, key, (w) => ({
    ...withoutExorcised(w, nick),
    members: addMember(w.members, nick),
  }));
  return done(
    appendTo(withMember, key, { kind: "join", text: `${nick} has joined ${channel}`, from: nick, ...prefixSpec(msg) }, nowMs),
  );
}

function onNames(state: ClientState, msg: IrcMessage, nowMs: number): ReduceResult {
  // 353: <me> <= | * | @> <channel> :names
  const channel = msg.params[2];
  const names = msg.params[3] ?? "";
  if (channel === undefined) return statusLine(state, msg, nowMs);
  const key = channelKey(channel);
  if (getOwn(state.windows, key) === undefined) return done(state);
  let next = updateWindow(state, key, (w) => ({ ...w, members: mergeMembers(w.members, parseNames(names)) }));
  if (state.expectingNames.includes(key)) {
    next = appendTo(next, state.activeKey, { kind: "local", text: `Users on ${channel}: ${names}` }, nowMs);
  }
  return done(next);
}

function onEndOfNames(state: ClientState, msg: IrcMessage): ReduceResult {
  const channel = msg.params[1];
  if (channel === undefined) return done(state);
  const key = channelKey(channel);
  return done({ ...state, expectingNames: state.expectingNames.filter((k) => k !== key) });
}

function onChat(state: ClientState, msg: IrcMessage, nowMs: number): ReduceResult {
  const isNotice = msg.command === "NOTICE";
  const target = msg.params[0];
  const raw = msg.params[1] ?? "";
  if (target === undefined) return statusLine(state, msg, nowMs);
  if (isNotice && isServerPrefix(msg.prefix)) {
    const server = msg.prefix ?? state.server ?? "server";
    return done(appendStatus(state, { kind: "notice", text: `-${server}- ${raw}` }, nowMs));
  }
  const from = nickOf(msg.prefix);
  const own = isOwnNick(state, from);
  const cls = classifyLine(
    isNotice ? { command: "NOTICE", from, text: raw } : { command: "PRIVMSG", from, text: raw },
  );
  const action = cls.kind === "action" ? ACTION.exec(raw) : null;
  const text = action !== null ? (action[1] ?? "") : raw;

  if (isChannelName(target)) {
    const key = channelKey(target);
    if (getOwn(state.windows, key)?.kind !== "channel") return done(state);
    const mention = !own && isMention(text, state.ownNick);
    return done(appendTo(state, key, { kind: cls.kind, text, from, mention, own }, nowMs), mention);
  }
  if (!isOwnNick(state, target) || from === "") return done(state);
  const key = queryKey(from);
  const mention = !own && isMention(text, state.ownNick);
  const known = getOwn(state.windows, key) !== undefined;
  if (!known && queryCount(state) >= MAX_QUERIES) {
    // Too many open queries: further new senders are shown in Status instead of opening windows.
    return done(appendStatus(state, { kind: cls.kind, text, from, mention, own }, nowMs), mention);
  }
  const opened = known ? state : openWindow(state, "query", from, false);
  return done(appendTo(opened, key, { kind: cls.kind, text, from, mention, own }, nowMs), mention);
}

/** Close a channel window, keeping its lines in `closedLines`; activate Status if it was active. */
function closeChannel(state: ClientState, key: string): ClientState {
  const win = getOwn(state.windows, key);
  if (win === undefined) return state;
  return {
    ...state,
    windows: withoutEntry(state.windows, key),
    order: state.order.filter((k) => k !== key),
    activeKey: state.activeKey === key ? "status" : state.activeKey,
    closedLines: rememberClosed(state, key, win.lines),
  };
}

function onLeave(state: ClientState, msg: IrcMessage, nowMs: number): ReduceResult {
  const isKick = msg.command.toUpperCase() === "KICK";
  const channel = msg.params[0];
  const who = isKick ? msg.params[1] : nickOf(msg.prefix);
  if (channel === undefined || who === undefined || who === "") return statusLine(state, msg, nowMs);
  const key = channelKey(channel);
  if (getOwn(state.windows, key)?.kind !== "channel") return done(state);
  const reason = (isKick ? msg.params[2] : msg.params[1]) ?? "";
  let suffix = reason === "" ? "" : ` (${reason})`;
  let text: string;
  if (isKick) {
    const kicker = nickOf(msg.prefix);
    // Same empty-reason rule as the exorcism line (R11.2, R11.5).
    const shown = exorcismText({ agent: who, kicker, reason }).reason;
    suffix = shown === undefined ? "" : ` (${shown})`;
    text = `${who} was kicked from ${channel} by ${kicker === "" ? "the server" : kicker}${suffix}`;
  } else {
    text = `${who} has left ${channel}${suffix}`;
  }
  const own = isOwnNick(state, who);
  const cls = isKick
    ? classifyLine({ command: "KICK", kicker: nickOf(msg.prefix), target: who, reason })
    : classifyLine({ command: "PART", nick: who, reason });
  const logged = appendTo(
    state,
    key,
    {
      kind: cls.kind,
      text,
      ...(cls.exorcism !== undefined ? { exorcism: cls.exorcism } : {}),
      ...(isKick ? {} : { from: who, ...prefixSpec(msg) }),
    },
    nowMs,
  );
  if (own) return done(closeChannel(logged, key));
  return done(
    updateWindow(logged, key, (w) => {
      const pruned = { ...w, members: removeMember(w.members, who) };
      return cls.kind === "exorcised-kick" ? withExorcised(pruned, who) : pruned;
    }),
  );
}

function onQuit(state: ClientState, msg: IrcMessage, nowMs: number): ReduceResult {
  const nick = nickOf(msg.prefix);
  if (nick === "") return statusLine(state, msg, nowMs);
  const reason = msg.params[0] ?? "";
  const text = `${nick} has quit${reason === "" ? "" : ` (${reason})`}`;
  let next = state;
  for (const key of state.order) {
    const win = getOwn(next.windows, key);
    if (win?.kind !== "channel" || !hasMember(win.members, nick)) continue;
    next = updateWindow(next, key, (w) => ({ ...w, members: removeMember(w.members, nick) }));
    next = appendTo(next, key, { kind: "quit", text, from: nick, ...prefixSpec(msg) }, nowMs);
  }
  const qKey = queryKey(nick);
  if (getOwn(next.windows, qKey)?.kind === "query") {
    next = appendTo(next, qKey, { kind: "quit", text, from: nick, ...prefixSpec(msg) }, nowMs);
  }
  return done(dropAway(next, nick));
}

/** 331 / 332 / TOPIC: set or clear the topic of an open channel and log it. */
function onTopic(state: ClientState, msg: IrcMessage, nowMs: number): ReduceResult {
  const isCmd = msg.command.toUpperCase() === "TOPIC";
  const channel = isCmd ? msg.params[0] : msg.params[1];
  if (channel === undefined) return statusLine(state, msg, nowMs);
  const key = channelKey(channel);
  if (getOwn(state.windows, key)?.kind !== "channel") return done(state);
  const text = (isCmd ? msg.params[1] : msg.command === "331" ? "" : msg.params[2]) ?? "";
  const updated = updateWindow(state, key, (w) => {
    const { topic: _old, ...rest } = w;
    void _old;
    return text === "" ? rest : { ...rest, topic: text };
  });
  let line: string;
  if (isCmd) {
    const setter = nickOf(msg.prefix);
    const who = setter === "" ? "Server" : setter;
    line = text === "" ? `${who} cleared the topic` : `${who} sets topic: ${text}`;
  } else {
    line = text === "" ? `No topic is set for ${channel}` : `Topic for ${channel}: ${text}`;
  }
  return done(appendTo(updated, key, { kind: "topic", text: line }, nowMs));
}

function onInvite(state: ClientState, msg: IrcMessage, nowMs: number): ReduceResult {
  const target = msg.params[0];
  const channel = msg.params[1];
  const inviter = nickOf(msg.prefix);
  if (target === undefined || channel === undefined || inviter === "" || !isOwnNick(state, target)) {
    return statusLine(state, msg, nowMs);
  }
  return done(appendTo(state, state.activeKey, { kind: "invite", text: `${inviter} invites you to ${channel}` }, nowMs));
}

/** 341 RPL_INVITING `<me> <target> <channel>`: `*** <me> invited <target>` in that channel (or Status). */
function onInviting(state: ClientState, msg: IrcMessage, nowMs: number): ReduceResult {
  const target = msg.params[1];
  const channel = msg.params[2];
  if (target === undefined || channel === undefined || target === "") return statusLine(state, msg, nowMs);
  const me = state.ownNick === "" ? (msg.params[0] ?? "") : state.ownNick;
  return done(appendTo(state, channelKey(channel), { kind: "invite", text: `${me} invited ${target}` }, nowMs));
}

/** 305 / 306: away status notices go to the Active_Window. */
function onAway(state: ClientState, msg: IrcMessage, nowMs: number): ReduceResult {
  return done(appendTo(onSelfAway(state, msg), state.activeKey, { kind: "numeric", text: numericText(msg) }, nowMs));
}

function onNick(state: ClientState, msg: IrcMessage, nowMs: number): ReduceResult {
  const from = nickOf(msg.prefix);
  const to = msg.params[0];
  if (from === "" || to === undefined || to === "") return statusLine(state, msg, nowMs);
  const own = isOwnNick(state, from);
  let next: ClientState = own ? { ...state, ownNick: to } : state;
  const text = own ? `You are now known as ${to}` : `${from} is now known as ${to}`;
  for (const key of state.order) {
    const win = getOwn(next.windows, key);
    if (win === undefined) continue;
    if (win.kind === "channel" && hasMember(win.members, from)) {
      next = updateWindow(next, key, (w) => ({ ...w, members: renameMember(w.members, from, to) }));
      next = appendTo(next, key, { kind: "nick", text }, nowMs);
    } else if (win.kind === "query" && key === queryKey(from)) {
      next = renameQuery(next, key, to);
      next = appendTo(next, queryKey(to), { kind: "nick", text }, nowMs);
    }
  }
  return done(moveAway(next, from, to));
}

/** Rename a Query_Window; if the new key is taken by another window, leave both as they are. */
function renameQuery(state: ClientState, oldKey: string, to: string): ClientState {
  const newKey = queryKey(to);
  const win = getOwn(state.windows, oldKey);
  if (win === undefined) return state;
  if (newKey === oldKey) return updateWindow(state, oldKey, (w) => ({ ...w, name: to }));
  if (getOwn(state.windows, newKey) !== undefined) return state;
  return {
    ...state,
    windows: withEntry(withoutEntry(state.windows, oldKey), newKey, { ...win, key: newKey, name: to }),
    order: state.order.map((k) => (k === oldKey ? newKey : k)),
    activeKey: state.activeKey === oldKey ? newKey : state.activeKey,
  };
}

function onMode(state: ClientState, msg: IrcMessage, nowMs: number): ReduceResult {
  const target = msg.params[0];
  const modes = msg.params[1];
  if (target !== undefined && modes !== undefined && !isChannelName(target) && isOwnNick(state, target)) {
    return done(applyUserModeChange(state, target, modes));
  }
  if (target === undefined || modes === undefined || !isChannelName(target)) return statusLine(state, msg, nowMs);
  const key = channelKey(target);
  if (getOwn(state.windows, key)?.kind !== "channel") return done(state);
  const args = msg.params.slice(2);
  const setter = nickOf(msg.prefix);
  const text = `${setter === "" ? "Server" : setter} sets mode: ${[modes, ...args].join(" ")}`;
  const withMembers = updateWindow(state, key, (w) => ({ ...w, members: applyModes(w.members, modes, args) }));
  const updated = applyChannelModeChange(withMembers, target, modes);
  return done(appendTo(updated, key, { kind: "mode", text }, nowMs));
}

function route(state: ClientState, msg: IrcMessage, nowMs: number): ReduceResult {
  switch (msg.command.toUpperCase()) {
    case "PART":
    case "KICK":
      return onLeave(state, msg, nowMs);
    case "QUIT":
      return onQuit(state, msg, nowMs);
    case "NICK":
      return onNick(state, msg, nowMs);
    case "MODE":
      return onMode(state, msg, nowMs);
    case "324": {
      const next = onChannelModeReply(state, msg);
      return next === undefined ? statusLine(state, msg, nowMs) : done(next);
    }
    case "221": {
      const next = onUserModeReply(state, msg);
      return next === undefined ? statusLine(state, msg, nowMs) : done(next);
    }
    case "331":
    case "332":
    case "TOPIC":
      return onTopic(state, msg, nowMs);
    case "INVITE":
      return onInvite(state, msg, nowMs);
    case "341":
      return onInviting(state, msg, nowMs);
    case "305":
    case "306":
      return onAway(state, msg, nowMs);
    case "AWAY":
      return done(onInboundAway(state, msg, nowMs));
    case "311":
    case "319":
    case "312":
    case "320":
    case "317":
      return done(onWhoisReply(state, msg, nowMs));
    case "301":
      return done(onWhoisReply(onAwayReply(state, msg), msg, nowMs));
    case "318":
      return done(onEndOfWhois(state, msg, nowMs));
    case "322":
    case "323":
      return done(onList(state, msg, nowMs));
    case "001":
      return onWelcome(state, msg, nowMs);
    case "PING": {
      const token = msg.params[0];
      return done(state, false, [{ command: "PONG", params: token === undefined ? [] : [token] }]);
    }
    case "PONG": {
      const token = msg.params[msg.params.length - 1];
      return token === undefined ? done(state) : { ...done(state), pong: token };
    }
    case "JOIN":
      return onJoin(state, msg, nowMs);
    case "353":
      return onNames(state, msg, nowMs);
    case "366":
      return onEndOfNames(state, msg);
    case "PRIVMSG":
    case "NOTICE":
      return onChat(state, msg, nowMs);
    default:
      if (isErrorNumeric(msg.command)) return done(onErrorNumeric(state, msg, nowMs));
      return statusLine(state, msg, nowMs);
  }
}

/**
 * Pure, total reducer for one inbound message. Never mutates `state`; an
 * unexpected failure becomes an error line in the Status_Window.
 */
export function reduce(state: ClientState, msg: IrcMessage, nowMs: number): ReduceResult {
  try {
    return route(state, msg, nowMs);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    try {
      return done(
        appendStatus(state, { kind: "error", text: `error: reduce failed on ${String(msg.command)}: ${reason}` }, nowMs),
      );
    } catch {
      return done(state);
    }
  }
}
