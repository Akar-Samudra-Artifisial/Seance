// Derived display data. Pure: no DOM, no React.
import { irc_lower } from "./casemap.js";
import { isKnownAgent } from "./classify.js";
import { formatIrc } from "./formatter.js";
import { getOwn } from "./record.js";
import type { ClientState, ExorcismParts, Member, Window } from "./types.js";

export { parseCreditsLine } from "./credits.js";
export type { CreditsLine } from "./credits.js";

export interface StatusCounts {
  readonly agents: number;
  readonly away: number;
  readonly ops: number;
  readonly users: number;
}

/** IRC codes and control characters removed (same rules as the Formatter). */
function plain(text: string): string {
  return formatIrc(text)
    .map((s) => s.text)
    .join("");
}

/** ` (+mnt)` for a mode string with flags, "" for "" or "+". */
export function modeSuffix(modes: string): string {
  const clean = plain(modes);
  return clean === "" || clean === "+" ? "" : ` (${clean})`;
}

/** Title_Bar and document title text for the Active_Window. Never contains control characters. */
export function titleOf(state: ClientState, host: string): string {
  const w = getOwn(state.windows, state.activeKey);
  let inner: string;
  if (w === undefined || w.kind === "status") {
    inner = `Status: ${state.ownNick}${modeSuffix(state.userModes)} on ${host}`;
  } else if (w.kind === "channel") {
    const topic = w.topic === undefined ? "" : plain(w.topic);
    inner = `${w.name}${modeSuffix(w.modes ?? "")}${topic === "" ? "" : `: ${topic}`}`;
  } else {
    inner = w.name;
  }
  return plain(`Séance — [${inner}]`);
}

function tally(members: readonly Member[], away: ClientState["away"]): StatusCounts {
  let agents = 0;
  let awayN = 0;
  let ops = 0;
  for (const m of members) {
    if (isKnownAgent(m.nick)) agents += 1;
    if (m.op) ops += 1;
    if (getOwn(away, irc_lower(m.nick)) !== undefined) awayN += 1;
  }
  return { agents, away: awayN, ops, users: members.length };
}

function membersOf(w: Window | undefined): readonly Member[] {
  if (w === undefined || w.kind !== "channel" || w.members === undefined) return [];
  return Object.values(w.members);
}

/**
 * Counts for the status bar. "active": members of the active channel window (zeros otherwise).
 * "all": distinct nicks over all channel windows. Exorcised nicks are never members, so never counted.
 */
export function statusCounts(state: ClientState, scope: "active" | "all"): StatusCounts {
  if (scope === "active") return tally(membersOf(getOwn(state.windows, state.activeKey)), state.away);
  const seen = new Map<string, Member>();
  for (const key of Object.keys(state.windows)) {
    for (const m of membersOf(getOwn(state.windows, key))) {
      const k = irc_lower(m.nick);
      const prev = seen.get(k);
      seen.set(k, prev === undefined ? m : { ...prev, op: prev.op || m.op });
    }
  }
  return tally([...seen.values()], state.away);
}

/** Sum of the latest credits total per agent. */
export function creditsTotal(state: ClientState): number {
  let sum = 0;
  for (const k of Object.keys(state.credits)) {
    const v = getOwn(state.credits, k);
    if (v !== undefined && Number.isFinite(v) && v >= 0) sum += v;
  }
  return sum;
}

/**
 * Pieces of the exorcism line. `reason` is undefined when it has no visible text
 * or equals the kicker under rfc1459 case-mapping; otherwise the raw reason (untrusted, render via IrcText).
 */
export function exorcismText(parts: ExorcismParts): {
  readonly agent: string;
  readonly kicker: string;
  readonly reason: string | undefined;
} {
  const visible = plain(parts.reason).trim();
  const hide = visible === "" || irc_lower(visible) === irc_lower(plain(parts.kicker).trim());
  return { agent: parts.agent, kicker: parts.kicker, reason: hide ? undefined : parts.reason };
}
