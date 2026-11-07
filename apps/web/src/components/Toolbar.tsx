"use client";
import { useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { useClientStore } from "../store/react.js";
import { Icon } from "./Icon.js";
import type { IconName } from "./Icon.js";

const buttonClass =
  "bevel-raised flex h-6 w-[26px] shrink-0 items-center justify-center bg-chrome-face text-chrome-outline focus-visible:outline-2 focus-visible:outline-chrome-outline aria-disabled:text-chrome-shadow";

interface ToolbarButton {
  readonly id: string;
  readonly icon: IconName;
  readonly label: string;
  readonly disabled: boolean;
  readonly run: () => void;
}

type ToolbarItem = ToolbarButton | "sep";

/** 32px icon toolbar (R3): connect, options, channels, agents, logs, theme and the theme label. */
export function Toolbar(): ReactNode {
  const phase = useClientStore((s) => s.client.phase);
  const hasConnected = useClientStore((s) => s.ui.hasConnected);
  const reconnect = useClientStore((s) => s.reconnect);
  const requestConnectDialog = useClientStore((s) => s.requestConnectDialog);
  const setActiveWindow = useClientStore((s) => s.setActiveWindow);
  const restoreWindow = useClientStore((s) => s.restoreWindow);
  const minimised = useClientStore((s) => s.ui.minimised);
  const [focusIndex, setFocusIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const registered = phase === "registered";
  // Reconnect needs a target: before the first connection the button stays "Connect".
  const canReconnect = (phase === "disconnected" || phase === "failed") && hasConnected;

  const items: readonly ToolbarItem[] = [
    {
      id: "connect",
      icon: "connect",
      label: canReconnect ? "Reconnect" : "Connect",
      // Nothing to connect while a session is live.
      disabled: registered,
      run: () => {
        if (canReconnect) reconnect();
        else requestConnectDialog();
      },
    },
    "sep",
    { id: "options", icon: "options", label: "Options", disabled: true, run: () => undefined },
    "sep",
    { id: "channels", icon: "channels", label: "Channel list", disabled: true, run: () => undefined },
    {
      id: "agents",
      icon: "agents",
      label: "Agents",
      disabled: false,
      run: () => {
        document.getElementById("nick-list")?.focus();
      },
    },
    "sep",
    {
      id: "logs",
      icon: "logs",
      label: "Status window",
      disabled: false,
      run: () => {
        if (minimised.includes("status")) restoreWindow("status");
        else setActiveWindow("status");
      },
    },
    "sep",
    { id: "theme", icon: "theme", label: "Toggle theme", disabled: true, run: () => undefined },
  ];
  const buttons = items.filter((item): item is ToolbarButton => item !== "sep");

  const moveTo = (index: number): void => {
    const next = (index + buttons.length) % buttons.length;
    setFocusIndex(next);
    listRef.current?.querySelectorAll<HTMLElement>("button")[next]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "ArrowRight") moveTo(focusIndex + 1);
    else if (event.key === "ArrowLeft") moveTo(focusIndex - 1);
    else if (event.key === "Home") moveTo(0);
    else if (event.key === "End") moveTo(buttons.length - 1);
    else return;
    event.preventDefault();
  };

  let buttonIndex = -1;
  return (
    <div className="flex h-8 items-center bg-chrome-face px-1 font-chrome text-xs text-chrome-outline">
      <div
        ref={listRef}
        role="toolbar"
        aria-label="Toolbar"
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
        className="flex items-center gap-[5px]"
      >
        {items.map((item, i) => {
          if (item === "sep") {
            return <span key={`sep-${String(i)}`} aria-hidden="true" className="bevel-sunken h-[22px] w-0.5" />;
          }
          buttonIndex += 1;
          const index = buttonIndex;
          return (
            <button
              key={item.id}
              type="button"
              aria-label={item.label}
              title={item.label}
              aria-disabled={item.disabled ? "true" : undefined}
              tabIndex={index === focusIndex ? 0 : -1}
              onFocus={() => {
                setFocusIndex(index);
              }}
              onClick={() => {
                if (!item.disabled) item.run();
              }}
              className={buttonClass}
            >
              <Icon name={item.icon} />
            </button>
          );
        })}
      </div>
      <span className="ml-auto whitespace-nowrap px-2">Theme: Ghost</span>
    </div>
  );
}
