"use client";

import type { ReactNode } from "react";
import { useClientStore } from "../store/react.js";

const buttonClass =
  "bevel-raised size-4 bg-chrome-face font-chrome text-xs leading-none text-chrome-outline focus-visible:outline-2 focus-visible:outline-chrome-outline";

/** 16px text-glyph icon buttons; no external assets. */
export function Toolbar(): ReactNode {
  const order = useClientStore((s) => s.client.order);
  const activeKey = useClientStore((s) => s.client.activeKey);
  const activateByIndex = useClientStore((s) => s.activateByIndex);
  const closeWindow = useClientStore((s) => s.closeWindow);
  const index = order.indexOf(activeKey);
  return (
    <div role="toolbar" aria-label="Toolbar" className="flex gap-1 bg-chrome-face px-1 py-0.5">
      <button
        type="button"
        aria-label="Previous window"
        disabled={index <= 0}
        onClick={() => {
          activateByIndex(index);
        }}
        className={buttonClass}
      >
        &lt;
      </button>
      <button
        type="button"
        aria-label="Next window"
        disabled={index < 0 || index >= order.length - 1}
        onClick={() => {
          activateByIndex(index + 2);
        }}
        className={buttonClass}
      >
        &gt;
      </button>
      <button
        type="button"
        aria-label="Close window"
        onClick={() => {
          closeWindow(activeKey);
        }}
        className={buttonClass}
      >
        x
      </button>
    </div>
  );
}
