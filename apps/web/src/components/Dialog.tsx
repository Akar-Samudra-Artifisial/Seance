"use client";

import { useEffect, useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { CLOSE_KEY } from "../shortcuts/shortcuts.js";

const FOCUSABLE = "input:not([disabled]), button:not([disabled]), [tabindex='0']";

export const captionClass =
  "hit-target bevel-button active:bevel-button-pressed flex h-[14px] w-4 shrink-0 items-center justify-center bg-chrome-face font-chrome text-[11px] font-bold leading-none text-chrome-outline focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-chrome-outline";

export interface DialogProps {
  readonly title: string;
  readonly titleId: string;
  /** Esc, the caption `X` button and every Close button call this. */
  readonly onClose: () => void;
  /** The caption `?` button; omit for dialogs without inline help. */
  readonly onHelp?: (() => void) | undefined;
  readonly helpExpanded?: boolean | undefined;
  readonly helpControls?: string | undefined;
  /** Size classes of the dialog box. */
  readonly className?: string | undefined;
  /** Replaces the overlay's stacking and backdrop classes (default `z-20 ... bg-chrome-outline/50 p-2`). */
  readonly overlayClassName?: string | undefined;
  readonly children: ReactNode;
}

/**
 * Modal dialog in the style of Figma frame 04 (Options): navy gradient title bar with 16x14 caption
 * buttons, bevelled body. Esc closes, Tab stays inside, and focus returns to the opener on close.
 */
export function Dialog(props: DialogProps): ReactNode {
  const boxRef = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    opener.current = document.activeElement;
    const box = boxRef.current;
    // Prefer a field in the body over the caption buttons.
    const target = box?.querySelector<HTMLElement>("[data-autofocus]") ?? box?.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();
    return () => {
      const back = opener.current;
      if (back instanceof HTMLElement && back.isConnected) back.focus();
      else document.getElementById("input-line")?.focus();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === CLOSE_KEY) {
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const items = Array.from(boxRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
      (el) => el.tabIndex >= 0,
    );
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) return;
    const current = document.activeElement;
    if (event.shiftKey && current === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && current === last) {
      event.preventDefault();
      first.focus();
    } else if (current instanceof HTMLElement && !items.includes(current)) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className={`fixed inset-0 flex items-center justify-center ${props.overlayClassName ?? "z-20 bg-chrome-outline/50 p-2"}`}>
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={props.titleId}
        onKeyDown={onKeyDown}
        className={`bevel-frame flex min-h-0 max-w-full flex-col bg-chrome-face p-0.5 font-chrome text-xs text-chrome-outline ${props.className ?? ""}`}
      >
        <div className="flex h-[18px] shrink-0 items-center bg-linear-to-r from-title-from to-title-to pl-1 pr-0.5">
          <h2 id={props.titleId} className="min-w-0 flex-1 truncate text-xs font-bold text-chrome-highlight">
            {props.title}
          </h2>
          {props.onHelp !== undefined ? (
            <button
              type="button"
              aria-label="Help"
              title="Show or hide the keyboard hint"
              aria-expanded={props.helpExpanded}
              aria-controls={props.helpControls}
              onClick={props.onHelp}
              className={captionClass}
            >
              ?
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Close"
            title="Close (Esc)"
            onClick={props.onClose}
            className={`${captionClass} ml-0.5`}
          >
            X
          </button>
        </div>
        {props.children}
      </div>
    </div>
  );
}
