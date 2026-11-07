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
