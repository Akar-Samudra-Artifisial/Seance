"use client";

import type { ReactNode } from "react";
import { formatIrc } from "../irc/index.js";
import type { Window } from "../irc/index.js";
import { useClientStore } from "../store/react.js";
import { Icon } from "./Icon.js";
import type { IconName } from "./Icon.js";
import { IrcText } from "./Spans.js";
import { hostOf } from "./TitleBar.js";

const captionClass =
  "bevel-raised flex h-3.5 w-4 shrink-0 items-center justify-center bg-chrome-face font-chrome text-[11px] leading-none text-chrome-outline focus-visible:outline-2 focus-visible:outline-chrome-outline disabled:text-chrome-shadow";

/** Text with IRC codes and control characters removed. */
function plain(text: string): string {
  return formatIrc(text)
    .map((s) => s.text)
    .join("");
}

/** Child title per R4.2. Parts that are empty (no topic, `""` or `+` modes) are omitted. */
export function childTitleOf(win: Window, ownNick: string, host: string): string {
  if (win.kind === "status") return `Status: ${ownNick} on ${host}`;
  if (win.kind === "query") return win.name;
  const modes = plain(win.modes ?? "");
  const topic = win.topic === undefined ? "" : plain(win.topic);
  return `${win.name}${modes === "" || modes === "+" ? "" : ` [${modes}]`}${topic === "" ? "" : `: ${topic}`}`;
}

export function iconOf(kind: Window["kind"]): IconName {
  return kind === "status" ? "status" : kind === "channel" ? "hash" : "ghost-coder";
}

/** Win95 MDI child: title bar (icon, title, minimise, maximise, close) around the window content. */
export function MdiChild(props: {
  readonly window: Window;
  readonly label: string;
  readonly children?: ReactNode;
}): ReactNode {
  const { window: win, label } = props;
  const active = useClientStore((s) => s.client.activeKey === win.key);
  const ownNick = useClientStore((s) => s.client.ownNick);
  const serverUrl = useClientStore((s) => s.ui.serverUrl);
  const setActiveWindow = useClientStore((s) => s.setActiveWindow);
  const minimiseWindow = useClientStore((s) => s.minimiseWindow);
  const closeWindow = useClientStore((s) => s.closeWindow);
  const title = childTitleOf(win, ownNick, hostOf(serverUrl));
  const surface = active
    ? "bg-linear-to-r from-title-from to-title-to text-chrome-highlight"
    : "bg-linear-to-r from-title-inactive-from to-title-inactive-to text-title-inactive-text";
  return (
    <section aria-label={label} className="bevel-raised flex min-h-0 min-w-0 flex-1 flex-col bg-chrome-face p-0.5">
      <header
        data-testid="mdi-title"
        data-active={active ? "true" : "false"}
        onClick={() => {
          setActiveWindow(win.key);
        }}
        className={`flex h-[18px] shrink-0 items-center gap-1 px-0.5 font-chrome text-xs font-bold ${surface}`}
      >
        <Icon name={iconOf(win.kind)} className="size-3.5" />
        <h2 className="min-w-0 flex-1 truncate text-xs font-bold leading-tight">
          <IrcText text={title} />
        </h2>
        <button
          type="button"
          aria-label="Minimise"
          onClick={(event) => {
            event.stopPropagation();
            minimiseWindow(win.key);
          }}
          className={captionClass}
        >
          <span aria-hidden="true">_</span>
        </button>
        <button
          type="button"
          aria-label="Maximise"
          onClick={(event) => {
            // The MDI area shows one window at a time, so it is always maximised; just activate it.
            event.stopPropagation();
            setActiveWindow(win.key);
          }}
          className={captionClass}
        >
          <span aria-hidden="true">□</span>
        </button>
        <button
          type="button"
          aria-label="Close"
          disabled={win.kind === "status"}
          onClick={(event) => {
            event.stopPropagation();
            closeWindow(win.key);
          }}
          className={captionClass}
        >
          <span aria-hidden="true">×</span>
        </button>
      </header>
      {props.children}
    </section>
  );
}
