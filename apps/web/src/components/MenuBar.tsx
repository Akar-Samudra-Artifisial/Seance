"use client";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { useClientStore } from "../store/react.js";
import { MenuPopup } from "./MenuPopup.js";
import type { InitialFocus, MenuEntry } from "./MenuPopup.js";

interface Menu {
  readonly id: string;
  readonly label: string;
  /** Index of the underlined mnemonic letter in `label`. */
  readonly mnemonic: number;
  /** A menu without supported items is rendered `aria-disabled` and never opens. */
  readonly disabled: boolean;
  readonly entries: readonly MenuEntry[];
}

const sep = (id: string): MenuEntry => ({ kind: "separator", id });

const barButtonClass =
  "h-5 px-2 font-chrome text-xs text-chrome-outline hover:bg-title-from hover:text-chrome-highlight focus-visible:bg-title-from focus-visible:text-chrome-highlight aria-expanded:bg-title-from aria-expanded:text-chrome-highlight aria-disabled:text-chrome-shadow aria-disabled:hover:bg-chrome-face aria-disabled:hover:text-chrome-shadow";

const childButtonClass =
  "bevel-raised flex h-3.5 w-4 items-center justify-center bg-chrome-face font-chrome text-xs leading-none text-chrome-outline focus-visible:outline-2 focus-visible:outline-chrome-outline disabled:text-chrome-shadow";

/** Win95 menu bar (R2): seven menus, roving tabindex, mnemonics, MDI child buttons at the right end. */
export function MenuBar(): ReactNode {
  const phase = useClientStore((s) => s.client.phase);
  const order = useClientStore((s) => s.client.order);
  const windows = useClientStore((s) => s.client.windows);
  const activeKey = useClientStore((s) => s.client.activeKey);
  const minimised = useClientStore((s) => s.ui.minimised);
  const mentionSound = useClientStore((s) => s.ui.mentionSound);
  const setMentionSound = useClientStore((s) => s.setMentionSound);
  const setActiveWindow = useClientStore((s) => s.setActiveWindow);
  const activateByIndex = useClientStore((s) => s.activateByIndex);
  const closeWindow = useClientStore((s) => s.closeWindow);
  const minimiseWindow = useClientStore((s) => s.minimiseWindow);
  const restoreWindow = useClientStore((s) => s.restoreWindow);
  const requestConnectDialog = useClientStore((s) => s.requestConnectDialog);
  const reconnect = useClientStore((s) => s.reconnect);
  const submitInput = useClientStore((s) => s.submitInput);
  const insertCommand = useClientStore((s) => s.insertCommand);
  const quit = useClientStore((s) => s.quit);

  const [barIndex, setBarIndex] = useState(0);
  const [open, setOpen] = useState<{ readonly index: number; readonly focus: InitialFocus } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const registered = phase === "registered";
  const active = windows[activeKey];
  const inChannel = registered && active?.kind === "channel";
  const index = order.indexOf(activeKey);
  const needsArgs = (prefix: string, enabled: boolean, id: string, label: string): MenuEntry => ({
    kind: "item",
    id,
    label,
    disabled: !enabled,
    run: () => {
      insertCommand(prefix);
    },
  });
  const command = (text: string, enabled: boolean, id: string, label: string): MenuEntry => ({
    kind: "item",
    id,
    label,
    disabled: !enabled,
    run: () => {
      submitInput(text);
    },
  });
  const unsupported = (id: string, label: string): MenuEntry => ({
    kind: "item",
    id,
    label,
    disabled: true,
    run: () => undefined,
  });

  const menus: readonly Menu[] = [
    {
      id: "file",
      label: "File",
      mnemonic: 0,
      disabled: false,
      entries: [
        {
          kind: "item",
          id: "connect",
          label: "Connect…",
          disabled: registered,
          run: requestConnectDialog,
        },
        {
          kind: "item",
          id: "reconnect",
          label: "Reconnect",
          disabled: phase !== "disconnected" && phase !== "failed",
          run: reconnect,
        },
        {
          kind: "item",
          id: "close",
          label: "Close window",
          disabled: active === undefined || active.kind === "status",
          run: () => {
            closeWindow(activeKey);
          },
        },
        sep("file-sep"),
        { kind: "item", id: "quit", label: "Quit", disabled: !registered, run: quit },
      ],
    },
    {
      id: "view",
      label: "View",
      mnemonic: 0,
      disabled: false,
      entries: [
        {
          kind: "item",
          id: "mention-sound",
          label: "Mention sound",
          checked: mentionSound,
          disabled: false,
          run: () => {
            setMentionSound(!mentionSound);
          },
        },
        sep("view-sep"),
        {
          kind: "item",
          id: "next",
          label: "Next window",
          disabled: index < 0 || index >= order.length - 1,
          run: () => {
            activateByIndex(index + 2);
          },
        },
        {
          kind: "item",
          id: "previous",
          label: "Previous window",
          disabled: index <= 0,
          run: () => {
            activateByIndex(index);
          },
        },
      ],
    },
    { id: "favorites", label: "Favorites", mnemonic: 1, disabled: true, entries: [] },
    {
      id: "tools",
      label: "Tools",
      mnemonic: 0,
      disabled: false,
      entries: [
        needsArgs(
          active?.kind === "query" ? `/whois ${active.name}` : "/whois ",
          registered,
          "whois",
          "Whois…",
        ),
        unsupported("options", "Options…"),
      ],
    },
    {
      id: "commands",
      label: "Commands",
      mnemonic: 0,
      disabled: false,
      entries: [
        needsArgs("/join #", registered, "join", "Join…"),
        command("/part", inChannel, "part", "Part"),
        needsArgs("/query ", registered, "query", "Query…"),
        command("/names", inChannel, "names", "Names"),
        needsArgs("/topic ", inChannel, "topic", "Topic…"),
        needsArgs("/away ", registered, "away", "Away…"),
        command("/away", registered, "back", "Back"),
        sep("commands-sep"),
        { kind: "item", id: "cmd-quit", label: "Quit", disabled: !registered, run: quit },
      ],
    },
    {
      id: "window",
      label: "Window",
      mnemonic: 0,
      disabled: false,
      entries: [
        ...order.flatMap((key): MenuEntry[] => {
          const win = windows[key];
          if (win === undefined) return [];
          return [
            {
              kind: "item",
              id: `win-${key}`,
              label: win.name,
              checked: key === activeKey,
              disabled: false,
              run: () => {
                if (minimised.includes(key)) restoreWindow(key);
                else setActiveWindow(key);
              },
            },
          ];
        }),
        sep("window-sep"),
        {
          kind: "item",
          id: "window-close",
          label: "Close window",
          disabled: active === undefined || active.kind === "status",
          run: () => {
            closeWindow(activeKey);
          },
        },
      ],
    },
    {
      id: "help",
      label: "Help",
      mnemonic: 0,
      disabled: false,
      // The client has no /help text yet, so the item stays inert.
      entries: [unsupported("shortcuts", "Keyboard shortcuts")],
    },
  ];

  const focusBar = (i: number): void => {
    setBarIndex(i);
    buttonRefs.current[i]?.focus();
  };
  const openMenu = (i: number, focus: InitialFocus): void => {
    const menu = menus[i];
    if (menu === undefined) return;
    setBarIndex(i);
    if (menu.disabled) {
      setOpen(null);
      buttonRefs.current[i]?.focus();
      return;
    }
    setOpen({ index: i, focus });
  };
  const close = (restoreFocus: boolean): void => {
    setOpen(null);
    if (restoreFocus) buttonRefs.current[barIndex]?.focus();
  };

  // Outside click closes the open menu.
  useEffect(() => {
    if (open === null) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && rootRef.current?.contains(event.target) === true) return;
      setOpen(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  // Alt+<mnemonic> opens a menu. `code` is used because Alt rewrites `key` on some layouts.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const match = /^Key([A-Z])$/.exec(event.code);
      if (match?.[1] === undefined) return;
      const at = menus.findIndex((m) => m.label.charAt(m.mnemonic).toUpperCase() === match[1]);
      if (at === -1) return;
      event.preventDefault();
      openMenu(at, "first");
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
    // Re-bound every render: the handler closes over this render's menus and state.
  });

  const onBarKeyDown = (event: KeyboardEvent<HTMLButtonElement>, i: number): void => {
    const count = menus.length;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowLeft": {
        event.preventDefault();
        const next = (i + (event.key === "ArrowRight" ? 1 : count - 1)) % count;
        if (open === null) focusBar(next);
        else openMenu(next, "first");
        return;
      }
      case "Home":
        event.preventDefault();
        focusBar(0);
        return;
      case "End":
        event.preventDefault();
        focusBar(count - 1);
        return;
      case "ArrowDown":
        event.preventDefault();
        openMenu(i, "first");
        return;
      case "ArrowUp":
        event.preventDefault();
        openMenu(i, "last");
        return;
      case "Escape":
        if (open !== null) {
          event.preventDefault();
          setOpen(null);
        }
        return;
      default:
    }
  };

  const onBarClick = (event: MouseEvent<HTMLButtonElement>, i: number): void => {
    if (open?.index === i) {
      setOpen(null);
      return;
    }
    // detail 0 = keyboard activation (Enter/Space): land on the first item.
    openMenu(i, event.detail === 0 ? "first" : "menu");
  };

  const canClose = active !== undefined && active.kind !== "status";

  return (
    <div className="flex h-5 items-center justify-between bg-chrome-face font-chrome">
      <div ref={rootRef} role="menubar" aria-label="Main menu" className="flex">
        {menus.map((menu, i) => {
          const isOpen = open?.index === i;
          return (
            <div key={menu.id} className="relative">
              <button
                ref={(el) => {
                  buttonRefs.current[i] = el;
                }}
                type="button"
                role="menuitem"
                id={`menu-${menu.id}`}
                aria-haspopup="menu"
                aria-expanded={isOpen}
                aria-controls={isOpen ? `menu-${menu.id}-list` : undefined}
                aria-disabled={menu.disabled ? "true" : undefined}
                aria-keyshortcuts={`Alt+${menu.label.charAt(menu.mnemonic).toUpperCase()}`}
                tabIndex={barIndex === i ? 0 : -1}
                onFocus={() => {
                  setBarIndex(i);
                }}
                onClick={(event) => {
                  onBarClick(event, i);
                }}
                onKeyDown={(event) => {
                  onBarKeyDown(event, i);
                }}
                onMouseEnter={() => {
                  // While a menu is open, hovering a neighbour switches to it like Win95.
                  if (open !== null && open.index !== i && !menu.disabled) openMenu(i, "menu");
                }}
                className={barButtonClass}
              >
                {menu.label.slice(0, menu.mnemonic)}
                <u>{menu.label.charAt(menu.mnemonic)}</u>
                {menu.label.slice(menu.mnemonic + 1)}
              </button>
              {isOpen ? (
                <MenuPopup
                  id={`menu-${menu.id}-list`}
                  label={menu.label}
                  entries={menu.entries}
                  initialFocus={open.focus}
                  onClose={close}
                  onSwitch={(direction) => {
                    openMenu((i + direction + menus.length) % menus.length, "first");
                  }}
                  onActivate={(run) => {
                    // Close and restore focus first so an item that moves focus (prefill, dialog) wins.
                    close(true);
                    run();
                  }}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      <div role="group" aria-label="Active window controls" className="flex gap-0.5 pr-1">
        <button
          type="button"
          aria-label="Minimise active window"
          onClick={() => {
            minimiseWindow(activeKey);
          }}
          className={childButtonClass}
        >
          <span aria-hidden="true">_</span>
        </button>
        <button
          type="button"
          aria-label="Restore active window"
          onClick={() => {
            restoreWindow(activeKey);
          }}
          className={childButtonClass}
        >
          <span aria-hidden="true">□</span>
        </button>
        <button
          type="button"
          aria-label="Close active window"
          disabled={!canClose}
          onClick={() => {
            closeWindow(activeKey);
          }}
          className={childButtonClass}
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
    </div>
  );
}
