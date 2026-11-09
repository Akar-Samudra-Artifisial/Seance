import { isParseError, parse, serialize } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import { splitPaste } from "./paste.js";
import { LINE_MAX_BYTES, PASTE_MAX_LINES } from "./types.js";
import type { WindowKind } from "./types.js";

/** Own message to show in a window, because the Ircd does not echo PRIVMSG to the sender. */
export interface EchoLine {
  /** Channel or nick the message was sent to (display case). */
  readonly target: string;
  readonly text: string;
}

/** Actions the Store performs locally without sending anything. */
export type LocalAction =
  | { readonly type: "status-line"; readonly text: string }
  | { readonly type: "open-query"; readonly nick: string };

export type InputResult =
  | {
      readonly kind: "send";
      readonly messages: readonly IrcMessage[];
      readonly echo: readonly EchoLine[];
      /** Nick whose Query_Window the Store opens and activates (/msg, /query with text). */
      readonly openQuery?: string;
    }
  | { readonly kind: "local"; readonly action: LocalAction }
  | { readonly kind: "error"; readonly text: string }
  | { readonly kind: "confirm-paste"; readonly lines: readonly string[]; readonly target: string };

export interface InputContext {
  readonly ownNick: string;
  readonly active: { readonly kind: WindowKind; readonly target: string };
  /** Nicks of the active window, for default targets (used by /kick in task 7.2). */
  readonly members?: readonly string[];
}

/** A command handler receives the text after the command word (leading spaces removed). */
type CommandHandler = (args: string, ctx: InputContext) => InputResult;

const NO_ACTIVE_WINDOW = "No channel or query is active. Use /join #channel to start.";

/** UTF-8 byte length without TextEncoder or Buffer (core has no DOM/Node globals). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Serialise-check: a produced line must fit in 512 bytes including CRLF. Returns an error text or undefined. */
export function checkLineLength(msg: IrcMessage): string | undefined {
  let line: string;
  try {
    line = serialize(msg);
  } catch {
    return `Line too long: a message may be at most ${LINE_MAX_BYTES} bytes including CRLF.`;
  }
  const bare = line.endsWith("\r\n") ? line.slice(0, -2) : line;
  if (utf8Length(bare) + 2 > LINE_MAX_BYTES) {
    return `Line too long: a message may be at most ${LINE_MAX_BYTES} bytes including CRLF.`;
  }
  return undefined;
}

export function send(
  messages: readonly IrcMessage[],
  echo: readonly EchoLine[] = [],
  openQuery?: string,
): InputResult {
  for (const m of messages) {
    const err = checkLineLength(m);
    if (err !== undefined) return { kind: "error", text: err };
  }
  return openQuery === undefined ? { kind: "send", messages, echo } : { kind: "send", messages, echo, openQuery };
}

export function usageError(command: string, usage: string): InputResult {
  return { kind: "error", text: `/${command}: usage: ${usage}` };
}

/** Plain text to the active window target as PRIVMSG, with echo. */
export function privmsgToActive(text: string, ctx: InputContext): InputResult {
  if (ctx.active.kind === "status") {
    return { kind: "local", action: { type: "status-line", text: NO_ACTIVE_WINDOW } };
  }
  const target = ctx.active.target;
  return send([{ command: "PRIVMSG", params: [target, text] }], [{ target, text }]);
}

/** Add a leading `#` when the channel name has none. */
export function normalizeChannel(name: string): string {
  return name.startsWith("#") ? name : `#${name}`;
}

/** Split `args` into its first whitespace-delimited word and the remaining text (leading spaces removed). */
function splitFirst(args: string): readonly [string, string] {
  const trimmed = args.replace(/^\s+/, "");
  const space = trimmed.search(/\s/);
  if (space === -1) return [trimmed, ""];
  return [trimmed.slice(0, space), trimmed.slice(space).replace(/^\s+/, "")];
}

/** Whitespace-separated words of `args`, without empty entries. */
function words(args: string): readonly string[] {
  return args.split(/\s+/).filter((p) => p.length > 0);
}

/** The channel of the Active_Window, or undefined when it is not a channel. */
function activeChannel(ctx: InputContext): string | undefined {
  return ctx.active.kind === "channel" ? ctx.active.target : undefined;
}

/** Params for a command that takes an optional leading channel followed by optional text. */
function channelAndText(args: string, ctx: InputContext): { channel: string; text: string } | undefined {
  const [first, rest] = splitFirst(args);
  if (first.startsWith("#")) return { channel: first, text: rest };
  const channel = activeChannel(ctx);
  return channel === undefined ? undefined : { channel, text: args.trim().length === 0 ? "" : args };
}

const joinCommand: CommandHandler = (args) => {
  const [channel, key] = words(args);
  if (channel === undefined) return usageError("join", "/join <channel>[ <key>]");
  const params = key === undefined ? [normalizeChannel(channel)] : [normalizeChannel(channel), key];
  return send([{ command: "JOIN", params }]);
};

const partCommand: CommandHandler = (args, ctx) => {
  const parsed = channelAndText(args, ctx);
  if (parsed === undefined) return usageError("part", "/part [<channel>][ <reason>]");
  const params = parsed.text.length === 0 ? [parsed.channel] : [parsed.channel, parsed.text];
  return send([{ command: "PART", params }]);
};

const msgCommand: CommandHandler = (args) => {
  const [target, text] = splitFirst(args);
  if (target.length === 0 || text.length === 0) return usageError("msg", "/msg <target> <text>");
  const isNick = !/^[#&]/.test(target);
  return send([{ command: "PRIVMSG", params: [target, text] }], [{ target, text }], isNick ? target : undefined);
};

const topicCommand: CommandHandler = (args, ctx) => {
  const parsed = channelAndText(args, ctx);
  if (parsed === undefined) return usageError("topic", "/topic [<channel>][ <text>]");
  const params = parsed.text.length === 0 ? [parsed.channel] : [parsed.channel, parsed.text];
  return send([{ command: "TOPIC", params }]);
};

const inviteCommand: CommandHandler = (args, ctx) => {
  const [nick, channelArg] = words(args);
  const channel = channelArg ?? activeChannel(ctx);
  if (nick === undefined || channel === undefined) return usageError("invite", "/invite <nick>[ <channel>]");
  return send([{ command: "INVITE", params: [nick, channel] }]);
};

const kickCommand: CommandHandler = (args, ctx) => {
  // `/kick [<channel>] <nick>[ <reason>]`: a first word starting with # or & is the channel;
  // otherwise the active channel is used, as before.
  const [first, afterFirst] = splitFirst(args);
  const explicit = /^[#&]/.test(first);
  const channel = explicit ? first : activeChannel(ctx);
  const [nick, reason] = splitFirst(explicit ? afterFirst : args);
  if (nick.length === 0 || channel === undefined) return usageError("kick", "/kick [<channel>] <nick>[ <reason>]");
  return send([{ command: "KICK", params: reason.length === 0 ? [channel, nick] : [channel, nick, reason] }]);
};

const modeCommand: CommandHandler = (args) => {
  const params = words(args);
  if (params.length === 0) return usageError("mode", "/mode <target>[ <modes>[ <args>]]");
  return send([{ command: "MODE", params }]);
};

const whoisCommand: CommandHandler = (args) => {
  const [nick] = words(args);
  if (nick === undefined) return usageError("whois", "/whois <nick>");
  return send([{ command: "WHOIS", params: [nick] }]);
};

const namesCommand: CommandHandler = (args, ctx) => {
  const [channelArg] = words(args);
  const channel = channelArg ?? activeChannel(ctx);
  return send([{ command: "NAMES", params: channel === undefined ? [] : [channel] }]);
};

const listCommand: CommandHandler = (args) => send([{ command: "LIST", params: words(args) }]);

const awayCommand: CommandHandler = (args) => {
  const text = args.trim();
  return send([{ command: "AWAY", params: text.length === 0 ? [] : [text] }]);
};

const nickCommand: CommandHandler = (args) => {
  const [nick] = words(args);
  if (nick === undefined) return usageError("nick", "/nick <nick>");
  return send([{ command: "NICK", params: [nick] }]);
};

const quitCommand: CommandHandler = (args) => {
  const reason = args.trim();
  return send([{ command: "QUIT", params: reason.length === 0 ? [] : [reason] }]);
};

const CTCP = "\x01";

const meCommand: CommandHandler = (args, ctx) => {
  const text = args.trim();
  if (text.length === 0) return usageError("me", "/me <text>");
  if (ctx.active.kind === "status") {
    return { kind: "local", action: { type: "status-line", text: NO_ACTIVE_WINDOW } };
  }
  const target = ctx.active.target;
  const wrapped = `${CTCP}ACTION ${text}${CTCP}`;
  return send([{ command: "PRIVMSG", params: [target, wrapped] }], [{ target, text: wrapped }]);
};

const queryCommand: CommandHandler = (args) => {
  const [nick, text] = splitFirst(args);
  if (nick.length === 0) return usageError("query", "/query <nick>[ <text>]");
  if (text.length === 0) return { kind: "local", action: { type: "open-query", nick } };
  return send([{ command: "PRIVMSG", params: [nick, text] }], [{ target: nick, text }], nick);
};

/** Command table; keys are lower-case command names. */
export const COMMANDS: Readonly<Record<string, CommandHandler>> = {
  join: joinCommand,
  part: partCommand,
  msg: msgCommand,
  topic: topicCommand,
  invite: inviteCommand,
  kick: kickCommand,
  mode: modeCommand,
  whois: whoisCommand,
  names: namesCommand,
  list: listCommand,
  away: awayCommand,
  nick: nickCommand,
  quit: quitCommand,
  me: meCommand,
  query: queryCommand,
};

/** Raw pass-through for a command missing from the table: upper-case name, arguments unchanged. */
function rawCommand(name: string, args: string): InputResult {
  if (/[\r\n\0]/.test(name) || /[\r\n\0]/.test(args)) {
    return { kind: "error", text: `/${name}: control characters are not allowed` };
  }
  const parsed = parse(`${name.toUpperCase()} ${args}`.trimEnd());
  if (isParseError(parsed)) return { kind: "error", text: `/${name}: ${parsed.reason}` };
  return send([parsed]);
}

const NUL_REFUSED = "NUL is not allowed in input.";
const SINGLE_LINE_REQUIRED = "Commands must be a single line.";

/** Multi-line text: one PRIVMSG per non-empty line, never interpreted as a command. */
function parseMultiline(text: string, ctx: InputContext): InputResult {
  const firstLine = text.split(/\r\n|\n|\r/, 1)[0] ?? "";
  if (firstLine.startsWith("/") && !firstLine.startsWith("//")) {
    return { kind: "error", text: SINGLE_LINE_REQUIRED };
  }
  const lines = splitPaste(text);
  if (lines.length === 0) return { kind: "error", text: "Nothing to send." };
  if (ctx.active.kind === "status") {
    return { kind: "local", action: { type: "status-line", text: NO_ACTIVE_WINDOW } };
  }
  const target = ctx.active.target;
  if (lines.length > PASTE_MAX_LINES) return { kind: "confirm-paste", lines, target };
  return send(
    lines.map((line) => ({ command: "PRIVMSG", params: [target, line] })),
    lines.map((line) => ({ target, text: line })),
  );
}

export function parseInput(text: string, ctx: InputContext): InputResult {
  if (text.includes("\0")) return { kind: "error", text: NUL_REFUSED };
  if (/[\r\n]/.test(text)) return parseMultiline(text, ctx);
  if (text.startsWith("//")) return privmsgToActive(text.slice(1), ctx);
  if (!text.startsWith("/")) return privmsgToActive(text, ctx);

  const body = text.slice(1);
  const space = body.search(/\s/);
  const name = (space === -1 ? body : body.slice(0, space)).toLowerCase();
  const args = space === -1 ? "" : body.slice(space).replace(/^\s+/, "");
  if (name.length === 0) return { kind: "error", text: "Empty command. Type /help for a list." };

  // Own-property lookup only: names like "__proto__" or "constructor" must fall through to raw.
  const handler = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  return handler === undefined ? rawCommand(name, args) : handler(args, ctx);
}
