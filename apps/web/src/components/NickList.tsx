import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { isKnownAgent } from "../irc/classify.js";
import { pluralise } from "../irc/selectors.js";
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
import { MenuPopup } from "./MenuPopup.js";
import type { MenuEntry } from "./MenuPopup.js";
import { IrcText } from "./Spans.js";

/** What the nick list asks its owner to do for a nick (audit 10.5); the owner maps it to a command. */
export type NickAction = "whois" | "query" | "voice" | "devoice" | "kick";

const OPS_ONLY = "Channel operators only";

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
  /**
   * Makes the nicks interactive: double-click or Enter opens a query, a context menu (right-click,
   * Shift+F10, the Menu key) offers Whois, Query and, for channel operators, voice and kick.
   * Without it the list is plain, as before.
   */
  readonly onAction?: ((action: NickAction, nick: string) => void) | undefined;
  /** The user is a channel operator here: Give/Take voice and Kick are live instead of inert. */
  readonly canModerate?: boolean | undefined;
}): ReactNode {
  const away = props.away ?? NO_AWAY;
  const onAction = props.onAction;
  // The open menu: the nick and where it opens, in pixels relative to the list's root element (audit 10.17).
  const [menu, setMenu] = useState<{ readonly nick: string; readonly x: number; readonly y: number } | null>(null);
  const menuNick = menu === null ? null : menu.nick;
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const rootRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  // Per instance, so the pane and the compact overlay can never share a menu id.
  const menuId = `nick-menu-${useId()}`;

  /** Open the menu for `nick`: at the pointer for a mouse event, under the row for the keyboard. */
  const openMenu = (nick: string, at?: { readonly clientX: number; readonly clientY: number }): void => {
    const root = rootRef.current?.getBoundingClientRect();
    const rowBox = rows.current.get(nick)?.getBoundingClientRect();
    const originX = root?.left ?? 0;
    const originY = root?.top ?? 0;
    if (at !== undefined) setMenu({ nick, x: at.clientX - originX, y: at.clientY - originY });
    else setMenu({ nick, x: (rowBox?.left ?? originX) - originX, y: (rowBox?.bottom ?? originY) - originY });
  };
  const sorted = sortMembers(Object.values(props.members ?? {}));
  const users = sorted.length;
  const agents = sorted.filter((m) => isKnownAgent(m.nick)).length;
  const ghosts = (props.exorcised ?? []).filter((n) => !sorted.some((m) => keyOf(m.nick) === keyOf(n)));
  const pane = (props.variant ?? "pane") === "pane";
  const Root = pane ? "aside" : "div";
  const canModerate = props.canModerate === true;

  // A press outside the open menu closes it.
  useEffect(() => {
    if (menuNick === null) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && boxRef.current?.contains(event.target) === true) return;
      setMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [menuNick]);

  const menuMember = menuNick === null ? undefined : sorted.find((m) => m.nick === menuNick);

  // The target nick left while its menu was open: close the menu (state adjusted while rendering, so it
  // cannot reappear if the nick returns) ...
  if (menu !== null && menuMember === undefined) setMenu(null);
  // ... and when the closed menu took focus with it, put focus back on the list.
  const hadMenu = useRef(false);
  useEffect(() => {
    if (menu !== null) {
      hadMenu.current = true;
      return;
    }
    if (!hadMenu.current) return;
    hadMenu.current = false;
    const active = document.activeElement;
    if (active === null || active === document.body) listRef.current?.focus();
  }, [menu]);

  // Place the menu at its origin, then shift it back inside the viewport (audit 10.17).
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (menu === null || box === null) return;
    box.style.left = `${String(Math.round(menu.x))}px`;
    box.style.top = `${String(Math.round(menu.y))}px`;
    const popup = box.firstElementChild;
    if (popup === null) return;
    const r = popup.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    let dx = 0;
    let dy = 0;
    if (r.right > vw) dx = vw - r.right;
    if (r.left + dx < 0) dx = -r.left;
    if (r.bottom > vh) dy = vh - r.bottom;
    if (r.top + dy < 0) dy = -r.top;
    if (dx !== 0) box.style.left = `${String(Math.round(menu.x + dx))}px`;
    if (dy !== 0) box.style.top = `${String(Math.round(menu.y + dy))}px`;
  }, [menu]);

  const focusRow = (nick: string): void => {
    rows.current.get(nick)?.focus();
  };
  const moveRow = (from: number, to: number): void => {
    const target = sorted[Math.max(0, Math.min(sorted.length - 1, to))];
    if (target !== undefined && to !== from) focusRow(target.nick);
  };
  const onRowKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number, nick: string): void => {
    if (onAction === undefined) return;
    if (event.key === "ArrowDown") moveRow(index, index + 1);
    else if (event.key === "ArrowUp") moveRow(index, index - 1);
    else if (event.key === "Home") moveRow(index, 0);
    else if (event.key === "End") moveRow(index, sorted.length - 1);
    else if (event.key === "Enter") onAction("query", nick);
    else if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) openMenu(nick);
    else return;
    event.preventDefault();
  };
  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>): void => {
    // From the list itself (where the toolbar Agents button puts focus) the arrow keys enter the rows.
    if (onAction === undefined || event.target !== event.currentTarget) return;
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    if ((event.key === "ArrowDown" || event.key === "Home") && first !== undefined) focusRow(first.nick);
    else if ((event.key === "ArrowUp" || event.key === "End") && last !== undefined) focusRow(last.nick);
    else return;
    event.preventDefault();
  };

  const menuEntries = (m: { readonly nick: string; readonly voice: boolean }): readonly MenuEntry[] => [
    { kind: "item", id: "whois", label: "Whois", disabled: false, run: () => onAction?.("whois", m.nick) },
    { kind: "item", id: "query", label: "Query", disabled: false, run: () => onAction?.("query", m.nick) },
    { kind: "separator", id: "nick-menu-sep" },
    {
      kind: "item",
      id: "voice",
      label: m.voice ? "Take voice" : "Give voice",
      disabled: !canModerate,
      reason: OPS_ONLY,
      run: () => onAction?.(m.voice ? "devoice" : "voice", m.nick),
    },
    { kind: "item", id: "kick", label: "Kick", disabled: !canModerate, reason: OPS_ONLY, run: () => onAction?.("kick", m.nick) },
  ];

  return (
    <Root
      ref={(el: HTMLElement | null) => {
        rootRef.current = el;
      }}
      className={`${
        pane ? "ml-[3px] hidden w-(--layout-nick-medium) md:flex lg:w-(--layout-nick-desktop)" : "flex h-full w-full"
      } bevel-field relative min-h-0 shrink-0 flex-col bg-ghost-bg p-0.5 font-chat text-[15px]`}
    >
      <ul
        ref={listRef}
        id="nick-list"
        role="list"
        aria-label={`Members of ${props.channel} (${pluralise(users, "user")})`}
        tabIndex={0}
        onKeyDown={onListKeyDown}
        className="win95-scroll min-h-0 flex-1 overflow-y-auto pl-2 pr-3.5 pt-1.5 focus-visible:outline-2 focus-visible:outline-ghost-orange"
      >
        {sorted.map((m, index) => {
          const isAway = Object.hasOwn(away, keyOf(m.nick));
          const kind = agentKind(m.nick);
          const Ghost = kind === undefined ? undefined : isAway ? NickAgentResearcherAway : AGENT_ICON[kind];
          const prefix = memberPrefix(m);
          const label = (
            <>
              {prefix === "" ? null : <span className="text-timestamp-dim">{prefix}</span>}
              <IrcText text={m.nick} />
            </>
          );
          return (
            <li key={m.nick} className={`${rowClass} ${nickClass(m.nick, isAway)}`}>
              {onAction === undefined ? (
                <span className="min-w-0 truncate">{label}</span>
              ) : (
                <button
                  type="button"
                  ref={(el) => {
                    if (el === null) rows.current.delete(m.nick);
                    else rows.current.set(m.nick, el);
                  }}
                  tabIndex={-1}
                  aria-haspopup="menu"
                  title="Double-click or Enter: query. Right-click or Shift+F10: menu"
                  onDoubleClick={() => {
                    onAction("query", m.nick);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    openMenu(m.nick, { clientX: event.clientX, clientY: event.clientY });
                  }}
                  onKeyDown={(event) => {
                    onRowKeyDown(event, index, m.nick);
                  }}
                  className="min-w-0 truncate text-left leading-[22px] focus-visible:outline-2 focus-visible:outline-ghost-orange"
                >
                  {label}
                </button>
              )}
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
      {menuMember !== undefined && onAction !== undefined ? (
        <div ref={boxRef} className="absolute left-0 top-0 z-20">
          <MenuPopup
            id={menuId}
            label={`Actions for ${menuMember.nick}`}
            entries={menuEntries(menuMember)}
            initialFocus="first"
            onClose={(restoreFocus) => {
              const nick = menuMember.nick;
              setMenu(null);
              if (restoreFocus) focusRow(nick);
            }}
            onSwitch={() => undefined}
            onActivate={(run) => {
              const nick = menuMember.nick;
              setMenu(null);
              focusRow(nick);
              run();
            }}
          />
        </div>
      ) : null}
      <p className="mb-2.5 shrink-0 px-2 font-chat text-xs leading-3 text-timestamp-dim">{`${pluralise(users, "user")} · ${pluralise(agents, "agent")}`}</p>
    </Root>
  );
}
