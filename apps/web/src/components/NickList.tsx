import type { ReactNode } from "react";
import { isKnownAgent } from "../irc/classify.js";
import { keyOf } from "../irc/casemap.js";
import { memberPrefix, sortMembers } from "../irc/nick-order.js";
import type { Member } from "../irc/types.js";
import {
  NickAgentCoder,
  NickAgentResearcher,
  NickAgentResearcherAway,
  NickAgentReviewer,
} from "../icons/index.js";
import type { IconProps } from "../icons/index.js";
import { IrcText } from "./Spans.js";

type AgentKind = "coder" | "reviewer" | "researcher";

function agentKind(nick: string): AgentKind | undefined {
  const key = keyOf(nick);
  return key === "coder" || key === "reviewer" || key === "researcher" ? key : undefined;
}

const AGENT_ICON: Readonly<Record<AgentKind, (props: IconProps) => ReactNode>> = {
  coder: NickAgentCoder,
  reviewer: NickAgentReviewer,
  researcher: NickAgentResearcher,
};

function nickClass(nick: string, away: boolean): string {
  if (away) return "text-away-grey";
  switch (agentKind(nick)) {
    case "coder":
      return "text-nick-coder";
    case "reviewer":
      return "text-nick-reviewer";
    case "researcher":
      return "text-nick-researcher";
    default:
      return "text-nick-human";
  }
}

const NO_AWAY: Readonly<Record<string, string>> = Object.freeze(Object.create(null) as Record<string, string>);

/** Frame_01: rows on a 22 px pitch from y+9, x+10; ghost 11x14 near the right edge. */
const rowClass = "flex h-[22px] items-center justify-between leading-[22px]";
const ghostClass = "block h-[14px] w-[11px]";

/**
 * Member list of a channel, ordered ops, voiced, others; exorcised agents follow below.
 * `pane` is the right-hand column (181 px Desktop, 140 px Medium, hidden in Compact);
 * `overlay` fills the Compact NickOverlay.
 */
export function NickList(props: {
  readonly channel: string;
  readonly members: Readonly<Record<string, Member>> | undefined;
  /** Away text per nick, key = irc_lower(nick). */
  readonly away?: Readonly<Record<string, string>> | undefined;
  /** Kicked Known_Agents, shown struck through and not counted. */
  readonly exorcised?: readonly string[] | undefined;
  readonly variant?: "pane" | "overlay" | undefined;
}): ReactNode {
  const away = props.away ?? NO_AWAY;
  const sorted = sortMembers(Object.values(props.members ?? {}));
  const users = sorted.length;
  const agents = sorted.filter((m) => isKnownAgent(m.nick)).length;
  const ghosts = (props.exorcised ?? []).filter((n) => !sorted.some((m) => keyOf(m.nick) === keyOf(n)));
  const pane = (props.variant ?? "pane") === "pane";
  const Root = pane ? "aside" : "div";
  return (
    <Root
      className={`${
        pane ? "ml-[3px] hidden w-(--layout-nick-medium) md:flex lg:w-(--layout-nick-desktop)" : "flex h-full w-full"
      } bevel-field min-h-0 shrink-0 flex-col bg-ghost-bg p-0.5 font-chat text-[15px]`}
    >
      <ul
        id="nick-list"
        role="list"
        aria-label={`Members of ${props.channel} (${String(users)} users)`}
        tabIndex={0}
        className="win95-scroll min-h-0 flex-1 overflow-y-auto pl-2 pr-3.5 pt-1.5 focus-visible:outline-2 focus-visible:outline-ghost-orange"
      >
        {sorted.map((m) => {
          const isAway = Object.hasOwn(away, keyOf(m.nick));
          const kind = agentKind(m.nick);
          const Ghost = kind === undefined ? undefined : isAway ? NickAgentResearcherAway : AGENT_ICON[kind];
          const prefix = memberPrefix(m);
          return (
            <li key={m.nick} className={`${rowClass} ${nickClass(m.nick, isAway)}`}>
              <span className="min-w-0 truncate">
                {prefix === "" ? null : <span className="text-timestamp-dim">{prefix}</span>}
                <IrcText text={m.nick} />
              </span>
              {Ghost !== undefined ? (
                <span role="img" aria-label={isAway ? "agent, away" : "agent"} className="shrink-0">
                  <Ghost className={ghostClass} />
                </span>
              ) : null}
            </li>
          );
        })}
        {ghosts.map((n) => (
          <li key={`exorcised:${n}`} className={`${rowClass} line-through ${nickClass(n, false)}`}>
            <span className="min-w-0 truncate opacity-60">
              <IrcText text={n} />
            </span>
            <span role="img" aria-label="exorcised" className="shrink-0">
              <NickAgentResearcherAway className={ghostClass} />
            </span>
          </li>
        ))}
      </ul>
      <p className="mb-2.5 shrink-0 px-2 font-chat text-xs leading-3 text-timestamp-dim">{`${String(users)} users · ${String(agents)} agents`}</p>
    </Root>
  );
}
