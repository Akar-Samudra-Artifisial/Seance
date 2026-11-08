"use client";

import type { ReactNode } from "react";
import { formatIrc } from "../irc/index.js";
import type { Window } from "../irc/index.js";
import { MdiChildChannel, MdiChildQuery, TrayStatus } from "../icons/index.js";

/** Text with IRC codes and control characters removed. */
function plain(text: string): string {
  return formatIrc(text)
    .map((s) => s.text)
    .join("");
}

/** Child title per R4.2. Parts that are empty (no topic, `""` or `+` modes) are omitted. Used by the tray. */
export function childTitleOf(win: Window, ownNick: string, host: string): string {
  if (win.kind === "status") return `Status: ${ownNick} on ${host}`;
  if (win.kind === "query") return win.name;
  const modes = plain(win.modes ?? "");
  const topic = win.topic === undefined ? "" : plain(win.topic);
  return `${win.name}${modes === "" || modes === "+" ? "" : ` [${modes}]`}${topic === "" ? "" : `: ${topic}`}`;
}

/** 14 px child icon (pixel-match R2.2): monitor for Status, `#` for a channel, ghost for a query. */
export function ChildIcon(props: { readonly kind: Window["kind"]; readonly className?: string }): ReactNode {
  const className = props.className;
  if (props.kind === "status") return <TrayStatus {...(className === undefined ? {} : { className })} />;
  if (props.kind === "channel") return <MdiChildChannel {...(className === undefined ? {} : { className })} />;
  return <MdiChildQuery {...(className === undefined ? {} : { className })} />;
}

/**
 * The Maximised_Child: a labelled section around the window content. It has no title bar of its
 * own; the application frame carries the title, and the menu bar carries the child icon and buttons
 * (pixel-match R2.1, D2).
 */
export function MdiChild(props: {
  readonly window: Window;
  readonly label: string;
  readonly children?: ReactNode;
}): ReactNode {
  return (
    <section aria-label={props.label} data-window={props.window.key} className="flex min-h-0 min-w-0 flex-1 flex-col">
      {props.children}
    </section>
  );
}
