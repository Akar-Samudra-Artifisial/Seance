"use client";

import type { ReactNode } from "react";

/** First tab stop: visible only when focused, moves focus to the Input_Line. */
export function SkipLink(): ReactNode {
  return (
    <a
      href="#input-line"
      onClick={(event) => {
        event.preventDefault();
        document.getElementById("input-line")?.focus();
      }}
      className="sr-only focus:not-sr-only focus:bg-chrome-face focus:px-2 focus:py-0.5 focus:text-chrome-outline"
    >
      Skip to message input
    </a>
  );
}
