import type { ReactNode } from "react";
import { isKnownAgent } from "../irc/classify.js";
import { memberPrefix, sortMembers } from "../irc/nick-order.js";
import type { Member } from "../irc/types.js";

function nickClass(nick: string): string {
  const key = nick.toLowerCase();
  if (isKnownAgent(nick)) {
    if (key === "coder") return "text-nick-coder";
    if (key === "reviewer") return "text-nick-reviewer";
    if (key === "researcher") return "text-nick-researcher";
  }
  return "text-nick-human";
}

/** Member list of a channel, ordered ops, voiced, others. */
export function NickList(props: {
  readonly channel: string;
  readonly members: Readonly<Record<string, Member>> | undefined;
}): ReactNode {
  const sorted = sortMembers(Object.values(props.members ?? {}));
  const count = sorted.length;
  return (
    <aside className="flex w-40 shrink-0 flex-col font-chrome text-sm">
      <p className="px-1 text-chrome-outline">{count === 1 ? "1 nick" : `${count} nicks`}</p>
      <ul
        role="list"
        aria-label={`Members of ${props.channel}, ${count} ${count === 1 ? "member" : "members"}`}
        tabIndex={0}
        className="bevel-sunken min-h-0 flex-1 overflow-y-auto bg-ghost-bg p-1 focus-visible:outline-2 focus-visible:outline-ghost-orange"
      >
        {sorted.map((m) => (
          <li key={m.nick} className={nickClass(m.nick)}>
            {memberPrefix(m)}
            {m.nick}
          </li>
        ))}
      </ul>
    </aside>
  );
}
