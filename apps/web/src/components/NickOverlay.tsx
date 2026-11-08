"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { Member } from "../irc/index.js";
import { useClientStore } from "../store/react.js";
import { NickList } from "./NickList.js";

/** Id of the toolbar button that toggles the overlay; focus returns to it on close. */
export const AGENTS_BUTTON_ID = "toolbar-agents";
export const NICK_OVERLAY_ID = "nick-overlay";

/**
 * Compact nick list (pixel-match R11.4): an `aside` over the chat pane, 240 px or 80 % of the
 * viewport. Opening moves focus to the list; Escape, a tap outside or the toolbar button close it
 * and return focus to the button.
 */
export function NickOverlay(props: {
  readonly channel: string;
  readonly members: Readonly<Record<string, Member>> | undefined;
  readonly away?: Readonly<Record<string, string>> | undefined;
  readonly exorcised?: readonly string[] | undefined;
}): ReactNode {
  const setNickOverlay = useClientStore((s) => s.setNickOverlay);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    document.getElementById("nick-list")?.focus();
    const close = (): void => {
      setNickOverlay(false);
      document.getElementById(AGENTS_BUTTON_ID)?.focus();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (ref.current?.contains(target) === true) return;
      // The toolbar button toggles on its own click; closing here would reopen it.
      if (document.getElementById(AGENTS_BUTTON_ID)?.contains(target) === true) return;
      close();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [setNickOverlay]);

  return (
    <aside
      ref={ref}
      id={NICK_OVERLAY_ID}
      role="complementary"
      aria-label={`Members of ${props.channel}`}
      className="absolute inset-y-0 right-0 z-10 flex w-[min(var(--layout-nick-overlay),80vw)] bg-chrome-face"
    >
      <NickList
        channel={props.channel}
        members={props.members}
        away={props.away}
        exorcised={props.exorcised}
        variant="overlay"
      />
    </aside>
  );
}
