"use client";

import { useEffect, useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import type { Line, Member } from "../irc/index.js";
import { ChatLine } from "./ChatLine.js";

/** Row height of the chat text (15 px / 21 px). */
const ROW_PX = 21;

/** Scroll distance for a key, or undefined when the key does not scroll the buffer. */
function scrollDelta(key: string, viewport: number): number | undefined {
  switch (key) {
    case "PageUp":
      return -Math.max(ROW_PX, viewport - ROW_PX);
    case "PageDown":
      return Math.max(ROW_PX, viewport - ROW_PX);
    case "ArrowUp":
      return -ROW_PX;
    case "ArrowDown":
      return ROW_PX;
    default:
      return undefined;
  }
}

export function ChatBuffer(props: {
  readonly label: string;
  readonly lines: readonly Line[];
  /** Members of the channel; decides the `@` / `+` prefix of chat lines. */
  readonly members?: Readonly<Record<string, Member>> | undefined;
  /** Own nick, highlighted in mention lines. */
  readonly ownNick?: string | undefined;
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const offset = -new Date().getTimezoneOffset();
  useEffect(() => {
    const el = ref.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [props.lines.length]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const el = event.currentTarget;
    const delta = scrollDelta(event.key, el.clientHeight);
    if (delta === undefined) return;
    event.preventDefault();
    el.scrollTop += delta;
  };
  // Chat pane (pixel-match R7): the two-step sunken bevel wraps the scroller, so the always-visible
  // 16 px scrollbar sits inside the bevel as in Frame_01. Each ChatLine carries a 3 px mention bar
  // and 4 px padding, so 1 px here puts the bar at frame x 6 and the text at frame x 13.
  return (
    <div className="bevel-field flex min-h-0 min-w-0 flex-1 flex-col bg-ghost-bg p-0.5">
      <div
        ref={ref}
        role="log"
        aria-live="polite"
        aria-label={props.label}
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="win95-scroll-y flex min-h-0 flex-1 flex-col pb-1.5 pl-px pr-1 font-chat text-[15px] leading-[21px] text-ghost-text focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ghost-orange"
      >
        {/* mt-auto anchors short content to the bottom of the buffer. */}
        <div className="mt-auto">
          {props.lines.map((line) => (
            <ChatLine key={line.id} line={line} offsetMinutes={offset} members={props.members} ownNick={props.ownNick} />
          ))}
        </div>
      </div>
    </div>
  );
}
