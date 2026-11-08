import { irc_lower } from "./casemap.js";
import type { ExorcismParts, LineKind } from "./types.js";

/** Single source for agent nick colours and KICK classification. */
export const KNOWN_AGENTS = ["coder", "reviewer", "researcher"] as const;

const KNOWN_AGENT_KEYS: ReadonlySet<string> = new Set(KNOWN_AGENTS);

/** True when `nick` is a Known_Agent under rfc1459 case-mapping. */
export function isKnownAgent(nick: string): boolean {
  return KNOWN_AGENT_KEYS.has(irc_lower(nick));
}

export type ClassifyInput =
  | { readonly command: "KICK"; readonly kicker: string; readonly target: string; readonly reason: string }
  | { readonly command: "PART"; readonly nick: string; readonly reason: string }
  | { readonly command: "NOTICE"; readonly from: string; readonly text: string }
  | { readonly command: "PRIVMSG"; readonly from: string; readonly text: string };

export interface Classification {
  readonly kind: LineKind;
  /** Present only for "exorcised-kick". */
  readonly exorcism?: ExorcismParts;
}

const EXORCISED_REASON = /^\*\*\* \S+ has been exorcised$/;
const CTCP_ACTION = /^\x01ACTION(?: [^\x01]*)?\x01?$/;

function isToolNotice(text: string): boolean {
  return text.startsWith("using tool:") || text.startsWith("ops:");
}

/** Pure classification of an inbound message into a line kind. */
export function classifyLine(input: ClassifyInput): Classification {
  switch (input.command) {
    case "KICK":
      return isKnownAgent(input.target)
        ? {
            kind: "exorcised-kick",
            exorcism: { agent: input.target, kicker: input.kicker, reason: input.reason },
          }
        : { kind: "kick" };
    case "PART":
      return { kind: EXORCISED_REASON.test(input.reason) ? "exorcised" : "part" };
    case "NOTICE":
      if (isKnownAgent(input.from) && isToolNotice(input.text)) {
        return { kind: input.text.includes("denied") ? "tool-denied" : "tool" };
      }
      return { kind: "notice" };
    case "PRIVMSG":
      return { kind: CTCP_ACTION.test(input.text) ? "action" : "message" };
  }
}

/**
 * `***` lines drawn in the event green (`--color-event-green`, 00 Style guide "Chat line types").
 * Kick and exorcism lines keep their own styles. The single list for ChatLine and its tests.
 */
export const EVENT_LINE_KINDS: readonly LineKind[] = ["join", "part", "quit", "nick", "mode", "topic", "invite"];

/** Kinds whose line is dropped when its text has no visible character (web-client-pixel-match R9.2). */
export const GATED_KINDS: readonly LineKind[] = ["message", "action", "notice", "tool", "tool-denied", "local"];

/**
 * Text markers rendered next to colour so state never depends on colour alone (R14.10).
 * Event lines no longer need a "[kick]" marker: their "*** ... was kicked" text says it.
 */
export function markersFor(kind: LineKind, mention: boolean): readonly string[] {
  const markers: string[] = [];
  switch (kind) {
    case "tool":
      markers.push("[tool]");
      break;
    case "tool-denied":
      markers.push("[denied]");
      break;
    default:
      break;
  }
  if (mention) markers.push("[mention]");
  return markers;
}
