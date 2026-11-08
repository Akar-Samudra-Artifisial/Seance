"use client";

import type { ReactNode } from "react";
import { plain } from "../irc/index.js";
import type { Window } from "../irc/index.js";
import { useClientStore } from "../store/react.js";
import { CaptionButton } from "./CaptionButton.js";
import { ChildIcon } from "./MdiChild.js";
import { IrcText } from "./Spans.js";

/**
 * Bar of a minimised MDI_Child (R1.7): 176x24, raised frame around an inactive title strip with the
 * child icon at x7, the bold title at x26 and restore, maximise and close at x120, 136 and 154.
 */
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
      className="bevel-button h-6 w-44 shrink-0 bg-chrome-face p-[3px]"
    >
      <div className="flex h-[18px] min-w-0 items-center bg-linear-to-r from-title-inactive-from to-title-inactive-to pl-1 pr-[3px] font-chrome text-xs font-bold text-title-inactive-text">
        <button
          type="button"
          aria-label={`Restore ${title}`}
          onClick={() => {
            restoreWindow(win.key);
          }}
          className="hit-target flex min-w-0 flex-1 items-center gap-[5px] text-left focus-visible:outline-2 focus-visible:outline-chrome-outline"
        >
          <ChildIcon kind={win.kind} />
          <span className="min-w-0 flex-1 truncate font-bold">
            <IrcText text={title} />
          </span>
        </button>
        <CaptionButton
          kind="restore"
          label="Restore"
          title={`Restore ${title}`}
          onClick={() => {
            restoreWindow(win.key);
          }}
        />
        <CaptionButton
          kind="max"
          label="Maximise"
          title={`Maximise ${title}`}
          onClick={() => {
            // The client keeps one maximised window: maximising a minimised child restores it.
            restoreWindow(win.key);
          }}
        />
        <CaptionButton
          kind="close"
          label="Close"
          title={`Close ${title}`}
          className="ml-0.5"
          disabled={win.kind === "status"}
          onClick={() => {
            closeWindow(win.key);
          }}
        />
      </div>
    </div>
  );
}

/** Row between the Input_Line and the Switchbar; renders nothing when no window is minimised (R1.4). */
export function MinimisedTray(): ReactNode {
  const minimised = useClientStore((s) => s.ui.minimised);
  const windows = useClientStore((s) => s.client.windows);
  const bars = minimised.flatMap((key) => {
    const win = windows[key];
    return win === undefined ? [] : [win];
  });
  if (bars.length === 0) return null;
  return (
    <div
      role="region"
      aria-label="Minimised windows"
      // Frame_01: the tray row is the empty MDI area (#808080), the bars sit on it.
      className="mt-0.5 flex h-(--layout-tray) shrink-0 items-start gap-1 overflow-x-auto overflow-y-hidden bg-chrome-shadow pl-1.5 pt-0.5"
    >
      {bars.map((win) => (
        // Frame_01 node 1:1513: the caption is the window name only ("Status").
        <MinimisedBar key={win.key} window={win} title={win.name} />
      ))}
    </div>
  );
}
