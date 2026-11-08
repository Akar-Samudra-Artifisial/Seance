"use client";
import { useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { ToolAgents, ToolChannels, ToolConnect, ToolLogs, ToolOptions, ToolTheme } from "../icons/index.js";
import type { IconProps } from "../icons/index.js";
import { useClientStore } from "../store/react.js";
import { useCompact } from "./layout-hooks.js";
import { AGENTS_BUTTON_ID, NICK_OVERLAY_ID } from "./NickOverlay.js";

/** 26x24 two-step raised button; pressed while held (Figma 1:5054). */
const buttonClass =
  "hit-target bevel-button active:bevel-button-pressed flex h-6 w-[26px] shrink-0 items-center justify-center bg-chrome-face text-chrome-outline focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-chrome-outline aria-disabled:active:bevel-button [&:active:not([aria-disabled])>svg]:translate-x-px [&:active:not([aria-disabled])>svg]:translate-y-px";

interface ToolbarButton {
  readonly kind: "button";
  readonly id: string;
  readonly icon: (props: IconProps) => ReactNode;
  readonly label: string;
  readonly disabled: boolean;
  readonly run: () => void;
  /** Left margin: 4 px for the first button, 3 px after a separator, 1 px between channels and agents. */
  readonly offset: string;
  readonly domId?: string;
  readonly expanded?: boolean;
}

interface ToolbarSeparator {
  readonly kind: "separator";
  readonly id: string;
}

type ToolbarItem = ToolbarButton | ToolbarSeparator;

const sep = (id: string): ToolbarSeparator => ({ kind: "separator", id });

/**
 * 32 px icon toolbar (pixel-match R4): connect | options | channels agents | logs | theme, then the
 * theme label 33 px from the right edge (hidden in Compact).
 */
export function Toolbar(): ReactNode {
  const phase = useClientStore((s) => s.client.phase);
  const hasConnected = useClientStore((s) => s.ui.hasConnected);
  const reconnect = useClientStore((s) => s.reconnect);
  const requestConnectDialog = useClientStore((s) => s.requestConnectDialog);
  const setActiveWindow = useClientStore((s) => s.setActiveWindow);
  const restoreWindow = useClientStore((s) => s.restoreWindow);
  const minimised = useClientStore((s) => s.ui.minimised);
  const overlayOpen = useClientStore((s) => s.ui.nickOverlayOpen);
  const setNickOverlay = useClientStore((s) => s.setNickOverlay);
  const inChannel = useClientStore((s) => s.client.windows[s.client.activeKey]?.kind === "channel");
  const compact = useCompact();
  const [focusIndex, setFocusIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const registered = phase === "registered";
  // Reconnect needs a target: before the first connection the button stays "Connect".
  const canReconnect = (phase === "disconnected" || phase === "failed") && hasConnected;

  const items: readonly ToolbarItem[] = [
    {
      kind: "button",
      id: "connect",
      icon: ToolConnect,
      label: canReconnect ? "Reconnect" : "Connect",
      // Nothing to connect while a session is live.
      disabled: registered,
      offset: "ml-1",
      run: () => {
        if (canReconnect) reconnect();
        else requestConnectDialog();
      },
    },
    sep("sep-1"),
    { kind: "button", id: "options", icon: ToolOptions, label: "Options", disabled: true, offset: "ml-[3px]", run: () => undefined },
    sep("sep-2"),
    {
      kind: "button",
      id: "channels",
      icon: ToolChannels,
      label: "Channel list",
      disabled: true,
      offset: "ml-[3px]",
      run: () => undefined,
    },
    {
      kind: "button",
      id: "agents",
      icon: ToolAgents,
      label: "Agents",
      disabled: false,
      offset: "ml-px",
      domId: AGENTS_BUTTON_ID,
      ...(compact && inChannel ? { expanded: overlayOpen } : {}),
      run: () => {
        // Compact: toggle the nick overlay (R11.4); otherwise focus the nick list.
        if (compact) {
          if (!inChannel) return;
          if (overlayOpen) {
            setNickOverlay(false);
            document.getElementById(AGENTS_BUTTON_ID)?.focus();
          } else {
            setNickOverlay(true);
          }
          return;
        }
        document.getElementById("nick-list")?.focus();
      },
    },
    sep("sep-3"),
    {
      kind: "button",
      id: "logs",
      icon: ToolLogs,
      label: "Status window",
      disabled: false,
      offset: "ml-[3px]",
      run: () => {
        if (minimised.includes("status")) restoreWindow("status");
        else setActiveWindow("status");
      },
    },
    sep("sep-4"),
    {
      kind: "button",
      id: "theme",
      icon: ToolTheme,
      label: "Toggle theme",
      disabled: true,
      offset: "ml-[3px]",
      run: () => undefined,
    },
  ];
  const buttons = items.filter((item): item is ToolbarButton => item.kind === "button");

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
    // Frame_01 etches the line between menu bar and toolbar: shadow row, then highlight row.
    <div className="flex h-(--layout-toolbar) shrink-0 items-start bg-chrome-face pt-1 font-chrome text-xs text-chrome-outline shadow-[inset_0_1px_0_var(--color-chrome-shadow),inset_0_2px_0_var(--color-chrome-highlight)]">
      <div
        ref={listRef}
        role="toolbar"
        aria-label="Toolbar"
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
        className="flex items-start"
      >
        {items.map((item) => {
          if (item.kind === "separator") {
            // 2x22, 4 px after the button before it, 1 px lower than the buttons (R4.2).
            return (
              <span
                key={item.id}
                data-testid="toolbar-separator"
                aria-hidden="true"
                className="bevel-etched ml-1 mt-px h-[22px] w-0.5 shrink-0"
              />
            );
          }
          buttonIndex += 1;
          const index = buttonIndex;
          const Glyph = item.icon;
          return (
            <button
              key={item.id}
              id={item.domId}
              type="button"
              aria-label={item.label}
              title={item.label}
              aria-disabled={item.disabled ? "true" : undefined}
              aria-expanded={item.expanded}
              aria-controls={item.expanded === true ? NICK_OVERLAY_ID : undefined}
              data-toolbar-item={item.id}
              tabIndex={index === focusIndex ? 0 : -1}
              onFocus={() => {
                setFocusIndex(index);
              }}
              onClick={() => {
                if (!item.disabled) item.run();
              }}
              className={`${buttonClass} ${item.offset}`}
            >
              <Glyph />
            </button>
          );
        })}
      </div>
      {/* Frame_01: label box 1 px below the button tops (cap top at y 55), not centred. */}
      <span className="ml-auto mr-[33px] mt-px hidden self-start whitespace-nowrap leading-4 md:inline">Theme: Ghost</span>
    </div>
  );
}
