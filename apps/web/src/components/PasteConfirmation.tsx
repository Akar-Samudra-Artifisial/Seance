"use client";
import { useEffect, useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { PASTE_MAX_LINES } from "../irc/index.js";
import { useClientStore } from "../store/react.js";

/** Asks whether to send a multi-line paste; renders nothing when none is pending. */
export function PasteConfirmation(): ReactNode {
  const pending = useClientStore((s) => s.client.paste.pending);
  const confirmPaste = useClientStore((s) => s.confirmPaste);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const isPending = pending !== undefined;
  useEffect(() => {
    if (isPending) confirmRef.current?.focus();
  }, [isPending]);
  if (pending === undefined) return null;

  const total = pending.lines.length;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      confirmPaste(false);
    } else if (e.key === "Enter" && e.target === e.currentTarget) {
      e.preventDefault();
      confirmPaste(true);
    }
  };
  return (
    <div
      role="alertdialog"
      aria-labelledby="paste-confirm-title"
      aria-describedby="paste-confirm-desc"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="bevel-raised bg-chrome-face p-2 font-chrome text-sm text-chrome-outline"
    >
      <h3 id="paste-confirm-title" className="font-bold">
        Confirm paste
      </h3>
      <p id="paste-confirm-desc">
        {`Paste of ${total} lines to ${pending.target}. Only the first ${PASTE_MAX_LINES} lines can be sent.`}
      </p>
      <div className="mt-1 flex gap-2">
        <button
          ref={confirmRef}
          type="button"
          onClick={() => confirmPaste(true)}
          className="bevel-raised bg-chrome-face px-3 focus-visible:outline-2 focus-visible:outline-chrome-outline"
        >
          {`Send first ${Math.min(total, PASTE_MAX_LINES)}`}
        </button>
        <button
          type="button"
          onClick={() => confirmPaste(false)}
          className="bevel-raised bg-chrome-face px-3 focus-visible:outline-2 focus-visible:outline-chrome-outline"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
