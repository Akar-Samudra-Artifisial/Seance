"use client";

import type { ReactNode } from "react";
import type { Window, WindowKind } from "../irc/index.js";
import { SwitchChannel, SwitchQuery, SwitchStatus } from "../icons/index.js";
import { useClientStore } from "../store/react.js";
import { CreditsCounter } from "./CreditsCounter.js";

/** 12 px switchbar icon (R8.1), in a 12 px slot so the text starts at the same x for every kind. */
function SwitchIcon(props: { readonly kind: WindowKind }): ReactNode {
  return (
    <span aria-hidden="true" className="flex w-3 shrink-0 justify-center">
      {props.kind === "status" ? <SwitchStatus /> : props.kind === "channel" ? <SwitchChannel /> : <SwitchQuery />}
    </span>
  );
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

/**
 * Switchbar (R1.7, R8): 156x22 buttons on a 160 px pitch from x2, y2; icon at x7, text at x24.
 * In Compact the buttons scroll inside the row and the credits panel stays at the right (R11.4).
 */
export function Switchbar(): ReactNode {
  const order = useClientStore((s) => s.client.order);
  const windows = useClientStore((s) => s.client.windows);
  const activeKey = useClientStore((s) => s.client.activeKey);
  const setActiveWindow = useClientStore((s) => s.setActiveWindow);
  return (
    <div className="mt-0.5 flex h-(--layout-switchbar) shrink-0 items-start bg-chrome-face pt-0.5 font-chrome text-[12px]">
      <nav
        aria-label="Windows"
        className="flex min-w-0 flex-1 items-start gap-1 overflow-x-auto overflow-y-hidden pl-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {order.map((key) => {
          const win = windows[key];
          if (win === undefined) return null;
          const active = key === activeKey;
          // R8.2: mention orange wins over unread #000080 (title-from); otherwise black.
          const tone = win.mentioned ? "text-ghost-orange" : win.unread ? "text-title-from" : "text-switch-text";
          return (
            <button
              key={key}
              type="button"
              aria-label={switchbarLabel(win, active)}
              aria-current={active ? "true" : undefined}
              onClick={() => {
                setActiveWindow(key);
              }}
              className={`${active ? "bevel-button-pressed bg-switch-active font-bold" : "bevel-button bg-switch-face"} ${tone} hit-target flex h-[22px] w-39 shrink-0 items-center gap-[5px] pl-[5px] pr-1.5 text-left`}
            >
              <SwitchIcon kind={win.kind} />
              <span className="truncate">{win.name}</span>
            </button>
          );
        })}
      </nav>
      <CreditsCounter />
    </div>
  );
}
