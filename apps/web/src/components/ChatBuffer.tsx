"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { Line } from "../irc/index.js";
import { ChatLine } from "./ChatLine.js";

export function ChatBuffer(props: {
  readonly label: string;
  readonly lines: readonly Line[];
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const offset = -new Date().getTimezoneOffset();
  useEffect(() => {
    const el = ref.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [props.lines.length]);
  return (
    <div
      ref={ref}
      role="log"
      aria-live="polite"
      aria-label={props.label}
      tabIndex={0}
      className="bevel-sunken min-h-0 flex-1 overflow-y-auto bg-ghost-bg p-1 font-chat text-[15px] leading-snug text-ghost-text focus-visible:outline-2 focus-visible:outline-ghost-orange"
    >
      {props.lines.map((line) => (
        <ChatLine key={line.id} line={line} offsetMinutes={offset} />
      ))}
    </div>
  );
}
