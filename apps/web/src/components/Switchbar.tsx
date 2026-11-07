"use client";

import type { ReactNode } from "react";
import type { Window } from "../irc/index.js";
import { useClientStore } from "../store/react.js";

/** Accessible name of a Switchbar button: window name plus active, unread and mention state. */
export function switchbarLabel(win: Window, active: boolean): string {
  const states = [
    ...(active ? ["active"] : []),
    ...(win.mentioned ? ["mentioned"] : []),
    ...(win.unread ? ["unread"] : []),
  ];
  return states.length === 0 ? win.name : `${win.name} (${states.join(", ")})`;
}

export function Switchbar(): ReactNode {
  const order = useClientStore((s) => s.client.order);
  const windows = useClientStore((s) => s.client.windows);
  const activeKey = useClientStore((s) => s.client.activeKey);
  const setActiveWindow = useClientStore((s) => s.setActiveWindow);
  return (
    <nav aria-label="Windows" className="flex gap-1 bg-chrome-face px-1 py-0.5 font-chrome text-sm">
      {order.map((key) => {
        const win = windows[key];
        if (win === undefined) return null;
        const active = key === activeKey;
        return (
          <button
            key={key}
            type="button"
            aria-label={switchbarLabel(win, active)}
            aria-current={active ? "true" : undefined}
            onClick={() => {
              setActiveWindow(key);
            }}
            className={`${active ? "bevel-sunken font-bold" : "bevel-raised"} bg-chrome-face px-2 text-chrome-outline focus-visible:outline-2 focus-visible:outline-chrome-outline`}
          >
            {win.name}
            {win.mentioned ? " (!)" : win.unread ? " *" : ""}
          </button>
        );
      })}
    </nav>
  );
}
