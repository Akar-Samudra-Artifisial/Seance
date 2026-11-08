import type { IrcMessage } from "@seance/irc-protocol";

export type ConnectionPhase = "disconnected" | "connecting" | "registering" | "registered" | "failed";

export interface ConnectParams {
  readonly nick: string;
  readonly serverUrl: string;
  /** Memory only; never persisted. */
  readonly password?: string;
}

export type LineKind =
  | "message"
  | "action"
  | "notice"
  | "join"
  | "part"
  | "quit"
  | "nick"
  | "mode"
  | "topic"
  | "invite"
  | "kick"
  | "exorcised"
  | "exorcised-kick"
  | "tool"
  | "tool-denied"
  | "system"
  | "error"
  | "motd"
  | "numeric"
  | "whois"
  | "local";

/** Structured pieces of an exorcism-by-kick line. All fields are untrusted plain text. */
export interface ExorcismParts {
  /** Target nick as sent by the server, original case. */
  readonly agent: string;
  /** Nick of the KICK prefix. */
  readonly kicker: string;
  /** Raw KICK reason, may hold control codes; "" when absent. */
  readonly reason: string;
}

export interface Line {
  /** Monotonically increasing per client; stable React key. */
  readonly id: number;
  /** Epoch ms; formatted [HH:MM] by the UI. */
  readonly at: number;
  readonly kind: LineKind;
  /** Nick for message-like kinds. */
  readonly from?: string;
  /** Raw text including IRC control codes. Untrusted. */
  readonly text: string;
  /** Set only when kind is "exorcised-kick". */
  readonly exorcism?: ExorcismParts;
  /** Set only when kind is "whois"; all fields are untrusted plain text. `text` is a one-line summary. */
  readonly whois?: WhoisPending;
  /** Set on join, part and quit lines from the message prefix. Untrusted plain text. */
  readonly prefix?: { readonly user: string; readonly host: string };
  /** Three-digit numeric of a server reply line; rendered dim before the text. */
  readonly code?: string;
  /** Message lines in a channel: the sender's `@` / `+` / "" when the line arrived. */
  readonly nickPrefix?: string;
  /** Set only on the action lines written for an inbound `AWAY`; user text can never set it. */
  readonly awayEvent?: "away" | "back";
  readonly mention: boolean;
  /** Sent by the own nick. */
  readonly own: boolean;
}

export type WindowKind = "status" | "channel" | "query";

export interface Member {
  /** Display case. */
  readonly nick: string;
  readonly op: boolean;
  readonly voice: boolean;
}

export interface Window {
  /** "status", or irc_lower(channel / nick). */
  readonly key: string;
  readonly kind: WindowKind;
  /** Display name with original case. */
  readonly name: string;
  /** At most BUFFER_CAP lines. */
  readonly lines: readonly Line[];
  readonly unread: boolean;
  readonly mentioned: boolean;
  /** Channel only; undefined = none set. */
  readonly topic?: string;
  /** Channel only; key = irc_lower(nick). */
  readonly members?: Readonly<Record<string, Member>>;
  /** Channel only; flags without arguments, sorted, e.g. `+mnt`. Undefined/"" = unknown or none. */
  readonly modes?: string;
  /** Channel only; display nicks of kicked Known_Agents, oldest first, at most EXORCISED_MAX. Never in `members`. */
  readonly exorcised?: readonly string[];
}

export interface WhoisPending {
  readonly nick: string;
  readonly user?: { readonly user: string; readonly host: string; readonly realname: string };
  readonly server?: { readonly name: string; readonly info: string };
  readonly channels: readonly string[];
  readonly away?: string;
  /** 320 lines (model, tools, credits). */
  readonly special: readonly string[];
  readonly idle?: { readonly seconds: number; readonly signon: number };
}

export interface PasteState {
  /** Owned by the Store timer, mirrored for the UI. */
  readonly queue: readonly IrcMessage[];
  /** Awaiting confirmation. */
  readonly pending?: { readonly lines: readonly string[]; readonly target: string };
}

export interface ClientState {
  readonly phase: ConnectionPhase;
  readonly connectError?: {
    readonly code: "in-use" | "erroneous" | "password" | "socket" | "origin-or-network";
    readonly text: string;
  };
  readonly ownNick: string;
  readonly server?: string;
  /** By window key. */
  readonly windows: Readonly<Record<string, Window>>;
  /** Switchbar order. */
  readonly order: readonly string[];
  /** "status" by default. */
  readonly activeKey: string;
  /** Lines of closed windows, for reopening in the same session. */
  readonly closedLines: Readonly<Record<string, readonly Line[]>>;
  /** Key = irc_lower(nick). */
  readonly whoisPending: Readonly<Record<string, WhoisPending>>;
  /** Latest credits `total` per agent from `320` lines; key = irc_lower(nick), null-prototype, max 50. */
  readonly credits: Readonly<Record<string, number>>;
  /** Away text per nick; key = irc_lower(nick), null-prototype, max 200 (AWAY_MAX). Cleared on reconnect. */
  readonly away: Readonly<Record<string, string>>;
  readonly nextLineId: number;
  readonly paste: PasteState;
  /** Channels whose NAMES reply came from a user-issued /names. */
  readonly expectingNames: readonly string[];
  /** Own user modes, e.g. `+iw`; "" when unknown. */
  readonly userModes: string;
}

export const BUFFER_CAP = 1000;
export const FRAME_MAX_BYTES = 64 * 1024;
export const HISTORY_MAX = 100;
export const PASTE_MAX_LINES = 5;
export const PASTE_INTERVAL_MS = 500;
export const LINE_MAX_BYTES = 512;
export const EXORCISED_MAX = 20;
