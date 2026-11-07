"use client";

import type { ReactNode } from "react";
import type { Window, WindowKind } from "../irc/index.js";
import { useClientStore } from "../store/react.js";
import { CreditsCounter } from "./CreditsCounter.js";
import { Icon } from "./Icon.js";
import type { IconName } from "./Icon.js";

function iconFor(kind: WindowKind): IconName {
  return kind === "status" ? "status" : kind === "channel" ? "hash" : "ghost-away";
}

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
    <div className="flex h-6.5 items-center gap-1 bg-chrome-face px-1 font-chrome text-[12px]">
      <nav aria-label="Windows" className="flex min-w-0 items-center gap-1 overflow-hidden">
        {order.map((key) => {
          const win = windows[key];
          if (win === undefined) return null;
          const active = key === activeKey;
          const tone = win.mentioned ? "text-ghost-orange" : win.unread ? "text-link-blue" : "text-switch-text";
          return (
            <button
              key={key}
              type="button"
              aria-label={switchbarLabel(win, active)}
              aria-current={active ? "true" : undefined}
              onClick={() => {
                setActiveWindow(key);
              }}
              className={`${active ? "bevel-sunken bg-switch-active font-bold" : "bevel-raised bg-switch-face"} ${tone} flex h-5.5 w-39 shrink-0 items-center gap-1 px-1.5 text-left`}
            >
              <Icon name={iconFor(win.kind)} className="size-3" />
              <span className="truncate">{win.name}</span>
            </button>
          );
        })}
      </nav>
      <CreditsCounter />
    </div>
  );
}
