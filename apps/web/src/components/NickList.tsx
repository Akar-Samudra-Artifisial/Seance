import type { ReactNode } from "react";
import { isKnownAgent } from "../irc/classify.js";
import { keyOf } from "../irc/casemap.js";
import { memberPrefix, sortMembers } from "../irc/nick-order.js";
import type { Member } from "../irc/types.js";
import { Icon } from "./Icon.js";
import type { IconName } from "./Icon.js";
import { IrcText } from "./Spans.js";

function agentIcon(nick: string): IconName | undefined {
  switch (keyOf(nick)) {
    case "coder":
      return "ghost-coder";
    case "reviewer":
      return "ghost-reviewer";
    case "researcher":
      return "ghost-researcher";
    default:
      return undefined;
  }
}

function nickClass(nick: string, away: boolean): string {
  if (away) return "text-away-grey";
  switch (agentIcon(nick)) {
    case "ghost-coder":
      return "text-nick-coder";
    case "ghost-reviewer":
      return "text-nick-reviewer";
    case "ghost-researcher":
      return "text-nick-researcher";
    default:
      return "text-nick-human";
  }
}

const NO_AWAY: Readonly<Record<string, string>> = Object.freeze(Object.create(null) as Record<string, string>);

/** Member list of a channel, ordered ops, voiced, others; exorcised agents follow below. */
export function NickList(props: {
  readonly channel: string;
  readonly members: Readonly<Record<string, Member>> | undefined;
  /** Away text per nick, key = irc_lower(nick). */
  readonly away?: Readonly<Record<string, string>> | undefined;
  /** Kicked Known_Agents, shown struck through and not counted. */
  readonly exorcised?: readonly string[] | undefined;
}): ReactNode {
  const away = props.away ?? NO_AWAY;
  const sorted = sortMembers(Object.values(props.members ?? {}));
  const users = sorted.length;
  const agents = sorted.filter((m) => isKnownAgent(m.nick)).length;
  const ghosts = (props.exorcised ?? []).filter((n) => !sorted.some((m) => keyOf(m.nick) === keyOf(n)));
  return (
    <aside className="flex w-[181px] shrink-0 flex-col bg-ghost-bg font-chat text-[15px]">
      <ul
        id="nick-list"
        role="list"
        aria-label={`Members of ${props.channel} (${String(users)} users)`}
        tabIndex={0}
        className="win95-scroll bevel-sunken min-h-0 flex-1 overflow-y-auto bg-ghost-bg p-1 focus-visible:outline-2 focus-visible:outline-ghost-orange"
      >
        {sorted.map((m) => {
          const isAway = Object.hasOwn(away, keyOf(m.nick));
          const icon = agentIcon(m.nick);
          return (
            <li
              key={m.nick}
              className={`mb-0.5 flex h-5 items-center justify-between leading-5 ${nickClass(m.nick, isAway)}`}
            >
              <span className="min-w-0 truncate">
                {memberPrefix(m)}
                <IrcText text={m.nick} />
              </span>
              {icon !== undefined ? (
                <span role="img" aria-label={isAway ? "agent, away" : "agent"} className="size-3 shrink-0">
                  <Icon name={isAway ? "ghost-away" : icon} className="size-3" />
                </span>
              ) : null}
            </li>
          );
        })}
        {ghosts.map((n) => (
          <li
            key={`exorcised:${n}`}
            className={`mb-0.5 flex h-5 items-center justify-between leading-5 line-through ${nickClass(n, false)}`}
          >
            <span className="min-w-0 truncate opacity-60">
              <IrcText text={n} />
            </span>
            <span role="img" aria-label="exorcised" className="size-3 shrink-0">
              <Icon name="ghost-away" className="size-3" />
            </span>
          </li>
        ))}
      </ul>
      <p className="px-1 font-chat text-xs text-timestamp-dim">{`${String(users)} users · ${String(agents)} agents`}</p>
    </aside>
  );
}
