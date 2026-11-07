"use client";

import type { ReactNode } from "react";
import { plain } from "../irc/index.js";
import type { Window } from "../irc/index.js";
import { useClientStore } from "../store/react.js";
import { Icon } from "./Icon.js";
import { childTitleOf, iconOf } from "./MdiChild.js";
import { IrcText } from "./Spans.js";
import { hostOf } from "./TitleBar.js";

const controlClass =
  "bevel-raised flex h-3.5 w-4 shrink-0 items-center justify-center bg-chrome-face font-chrome text-[11px] leading-none text-chrome-outline focus-visible:outline-2 focus-visible:outline-chrome-outline disabled:text-chrome-shadow";

/** Compact bar of a minimised MDI_Child: icon, bold title, restore and close. */
export function MinimisedBar(props: { readonly window: Window; readonly title: string }): ReactNode {
  const { window: win } = props;
  // Window names are untrusted; strip bidi and control characters from every attribute text.
  const title = plain(props.title);
  const restoreWindow = useClientStore((s) => s.restoreWindow);
  const closeWindow = useClientStore((s) => s.closeWindow);
  return (
    <div
      role="group"
      aria-label={`${title} (minimised)`}
      data-testid="minimised-bar"
      className="bevel-raised flex h-[22px] w-60 min-w-0 shrink-0 items-center gap-1 bg-chrome-face px-0.5 font-chrome text-xs font-bold text-chrome-outline"
    >
      <button
        type="button"
        aria-label={`Restore ${title}`}
        onClick={() => {
          restoreWindow(win.key);
        }}
        className="flex min-w-0 flex-1 items-center gap-1 text-left focus-visible:outline-2 focus-visible:outline-chrome-outline"
      >
        <Icon name={iconOf(win.kind)} className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-bold">
          <IrcText text={title} />
        </span>
      </button>
      <button
        type="button"
        aria-label="Restore"
        title={`Restore ${title}`}
        onClick={() => {
          restoreWindow(win.key);
        }}
        className={controlClass}
      >
        <span aria-hidden="true">❐</span>
      </button>
      <button
        type="button"
        aria-label="Close"
        title={`Close ${title}`}
        disabled={win.kind === "status"}
        onClick={() => {
          closeWindow(win.key);
        }}
        className={controlClass}
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}

/** Row between the Input_Line and the Switchbar; renders nothing when no window is minimised (R4.8). */
export function MinimisedTray(): ReactNode {
  const minimised = useClientStore((s) => s.ui.minimised);
  const windows = useClientStore((s) => s.client.windows);
  const ownNick = useClientStore((s) => s.client.ownNick);
  const serverUrl = useClientStore((s) => s.ui.serverUrl);
  const host = hostOf(serverUrl);
  const bars = minimised.flatMap((key) => {
    const win = windows[key];
    return win === undefined ? [] : [win];
  });
  if (bars.length === 0) return null;
  return (
    <div
      role="region"
      aria-label="Minimised windows"
      className="flex h-7 shrink-0 items-center gap-1 overflow-hidden bg-chrome-face px-1"
    >
      {bars.map((win) => (
        <MinimisedBar key={win.key} window={win} title={childTitleOf(win, ownNick, host)} />
      ))}
    </div>
  );
}
