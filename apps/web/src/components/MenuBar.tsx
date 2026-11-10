"use client";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { plain } from "../irc/index.js";
import { OverflowChevrons } from "../icons/index.js";
import { MENU_OVERFLOW, MENU_RESERVE, MENU_SLOTS } from "../layout/metrics.js";
import { MENU_DEFS, menuIndexForMnemonic, mnemonicOf } from "../shortcuts/shortcuts.js";
import type { MenuId } from "../shortcuts/shortcuts.js";
import { useClientStore } from "../store/react.js";
import { CaptionButton } from "./CaptionButton.js";
import { useFit } from "./layout-hooks.js";
import { ChildIcon } from "./MdiChild.js";
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
  // Frame_01 sets the menu text at the top of the 20 px bar (cap top at y 29, not centred).
  "hit-target h-5 px-2 pb-[7px] text-left font-chrome text-xs leading-[13px] text-chrome-outline hover:bg-title-from hover:text-chrome-highlight focus-visible:bg-title-from focus-visible:text-chrome-highlight aria-expanded:bg-title-from aria-expanded:text-chrome-highlight aria-disabled:text-chrome-shadow aria-disabled:hover:bg-chrome-face aria-disabled:hover:text-chrome-shadow";

/** Slot widths of R5.2 as static classes (File..Help); the order matches MENU_SLOTS. */
const SLOT_CLASS = ["w-[42px]", "w-[42px]", "w-[49px]", "w-[69px]", "w-[56px]", "w-[56px]"] as const;

/** `open.index` of the `»` list itself (Compact). */
const OVERFLOW = -1;

const RESTORE_TITLE = "Restore (this client keeps one maximised window)";

/** True on macOS and iOS, where Option+letter produces text. */
function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform) || /Mac OS X|iPhone|iPad/.test(navigator.userAgent);
}

/** Win95 menu bar (R2): seven menus, roving tabindex, mnemonics, MDI child buttons at the right end. */
export function MenuBar(): ReactNode {
  // Narrow subscriptions: a new chat line replaces `windows`, which must not re-render the menu bar.
  const phase = useClientStore((s) => s.client.phase);
  const order = useClientStore(useShallow((s) => s.client.order));
  const names = useClientStore(useShallow((s) => s.client.order.map((k) => s.client.windows[k]?.name ?? "")));
  const activeKey = useClientStore((s) => s.client.activeKey);
  const activeKind = useClientStore((s) => s.client.windows[s.client.activeKey]?.kind);
  const activeName = useClientStore((s) => s.client.windows[s.client.activeKey]?.name);
  const hasConnected = useClientStore((s) => s.ui.hasConnected);
  const minimised = useClientStore((s) => s.ui.minimised);
  const mentionSound = useClientStore((s) => s.ui.mentionSound);
  const setMentionSound = useClientStore((s) => s.setMentionSound);
  const theme = useClientStore((s) => s.ui.theme);
  const setTheme = useClientStore((s) => s.setTheme);
  const openChannelList = useClientStore((s) => s.openChannelList);
  const openShortcuts = useClientStore((s) => s.openShortcuts);
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
  const barRef = useRef<HTMLDivElement>(null);
  const overflowRef = useRef<HTMLButtonElement>(null);
  // Menus that fit; the rest go into the `»` list (R11.4). All fit from about 520 px up.
  const visible = useFit(barRef, MENU_SLOTS, MENU_RESERVE, MENU_OVERFLOW);

  const registered = phase === "registered";
  const active = activeKind === undefined ? undefined : { kind: activeKind, name: activeName ?? "" };
  const inChannel = registered && active?.kind === "channel";
  const index = order.indexOf(activeKey);
  const why = (enabled: boolean, reason: string): { readonly disabled: boolean; readonly reason?: string } =>
    enabled ? { disabled: false } : { disabled: true, reason };
  const needsArgs = (prefix: string, enabled: boolean, id: string, label: string, reason: string): MenuEntry => ({
    kind: "item",
    id,
    label,
    ...why(enabled, reason),
    run: () => {
      insertCommand(prefix);
    },
  });
  const command = (text: string, enabled: boolean, id: string, label: string, reason: string): MenuEntry => ({
    kind: "item",
    id,
    label,
    ...why(enabled, reason),
    run: () => {
      submitInput(text);
    },
  });
  const NOT_CONNECTED = "Connect first";
  const NOT_IN_CHANNEL = registered ? "Switch to a channel window first" : NOT_CONNECTED;
  const NO_CLOSE = "The Status window cannot be closed";

  const reconnectReason = !hasConnected
    ? "Connect first"
    : phase === "registered"
      ? "Already connected"
      : "Already connecting";

  const entries: Readonly<Record<MenuId, readonly MenuEntry[]>> = {
    file: [
      {
        kind: "item",
        id: "connect",
        label: "Connect…",
        ...why(!registered, "Disconnect first"),
        run: requestConnectDialog,
      },
      {
        kind: "item",
        id: "reconnect",
        label: "Reconnect",
        ...why(hasConnected && (phase === "disconnected" || phase === "failed"), reconnectReason),
        run: reconnect,
      },
      {
        kind: "item",
        id: "close",
        label: "Close window",
        ...why(active !== undefined && active.kind !== "status", NO_CLOSE),
        run: () => {
          closeWindow(activeKey);
        },
      },
      sep("file-sep"),
      { kind: "item", id: "quit", label: "Quit", ...why(registered, NOT_CONNECTED), run: quit },
    ],
    view: [
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
      sep("view-sep-theme"),
      {
        kind: "item",
        id: "theme-ghost",
        label: "Ghost theme",
        checked: theme === "ghost",
        disabled: false,
        run: () => {
          setTheme("ghost");
        },
      },
      {
        kind: "item",
        id: "theme-classic",
        label: "Classic theme",
        checked: theme === "classic",
        disabled: false,
        run: () => {
          setTheme("classic");
        },
      },
      sep("view-sep"),
      {
        kind: "item",
        id: "next",
        label: "Next window",
        ...why(index >= 0 && index < order.length - 1, "Already the last window"),
        run: () => {
          activateByIndex(index + 2);
        },
      },
      {
        kind: "item",
        id: "previous",
        label: "Previous window",
        ...why(index > 0, "Already the first window"),
        run: () => {
          activateByIndex(index);
        },
      },
    ],
    tools: [
      needsArgs(
        active?.kind === "query" ? `/whois ${active.name}` : "/whois ",
        registered,
        "whois",
        "Whois…",
        NOT_CONNECTED,
      ),
    ],
    commands: [
      needsArgs("/join #", registered, "join", "Join…", NOT_CONNECTED),
      {
        kind: "item",
        id: "channel-list",
        label: "Channel list…",
        ...why(registered, NOT_CONNECTED),
        run: openChannelList,
      },
      command("/part", inChannel, "part", "Part", NOT_IN_CHANNEL),
      needsArgs("/query ", registered, "query", "Query…", NOT_CONNECTED),
      command("/names", inChannel, "names", "Names", NOT_IN_CHANNEL),
      needsArgs("/topic ", inChannel, "topic", "Topic…", NOT_IN_CHANNEL),
      needsArgs("/away ", registered, "away", "Away…", NOT_CONNECTED),
      command("/away", registered, "back", "Back", NOT_CONNECTED),
      sep("commands-sep"),
      { kind: "item", id: "cmd-quit", label: "Quit", ...why(registered, NOT_CONNECTED), run: quit },
    ],
    window: [
      ...order.flatMap((key, at): MenuEntry[] => {
        const name = names[at];
        if (name === undefined) return [];
        return [
          {
            kind: "item",
            id: `win-${key}`,
            label: plain(name),
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
        ...why(active !== undefined && active.kind !== "status", NO_CLOSE),
        run: () => {
          closeWindow(activeKey);
        },
      },
    ],
    help: [
      {
        kind: "item",
        id: "shortcuts",
        label: "Keyboard shortcuts",
        disabled: false,
        run: openShortcuts,
      },
    ],
  };
  const menus: readonly Menu[] = MENU_DEFS.map((def) => ({ ...def, disabled: false, entries: entries[def.id] }));

  const count = menus.length;
  const hasOverflow = visible < count;
  /** The bar button that stands for menu `i`: its own button, or `»` when the menu is in the overflow. */
  const buttonFor = (i: number): HTMLButtonElement | null =>
    i < visible ? (buttonRefs.current[i] ?? null) : overflowRef.current;

  const focusBar = (i: number): void => {
    setBarIndex(i);
    buttonFor(i)?.focus();
  };
  const openMenu = (i: number, focus: InitialFocus): void => {
    if (i === OVERFLOW) {
      setBarIndex(visible);
      setOpen({ index: OVERFLOW, focus });
      return;
    }
    const menu = menus[i];
    if (menu === undefined) return;
    setBarIndex(i);
    if (menu.disabled) {
      setOpen(null);
      buttonFor(i)?.focus();
      return;
    }
    setOpen({ index: i, focus });
  };
  const close = (restoreFocus: boolean): void => {
    setOpen(null);
    if (restoreFocus) buttonFor(barIndex)?.focus();
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
      // On macOS Option+letter types characters (é, ø, …); leave them to the Input_Line.
      if (isApplePlatform() && event.target instanceof HTMLElement && event.target.id === "input-line") return;
      const at = menuIndexForMnemonic(match[1]);
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

  /** `i` is the menu the focused bar button stands for; `»` passes `OVERFLOW`. */
  const onBarKeyDown = (event: KeyboardEvent<HTMLButtonElement>, i: number): void => {
    const from = i === OVERFLOW ? Math.max(barIndex, visible) : i;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowLeft": {
        event.preventDefault();
        const next = (from + (event.key === "ArrowRight" ? 1 : count - 1)) % count;
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

  const popupFor = (i: number, menu: Menu, focus: InitialFocus, align: "left" | "right" = "left"): ReactNode => (
    <MenuPopup
      id={`menu-${menu.id}-list`}
      align={align}
      label={menu.label}
      entries={menu.entries}
      initialFocus={focus}
      onClose={close}
      onSwitch={(direction) => {
        openMenu((i + direction + count) % count, "first");
      }}
      onActivate={(run) => {
        // Close and restore focus first so an item that moves focus (prefill, dialog) wins.
        close(true);
        run();
      }}
    />
  );

  // The `»` list: one item per hidden menu; choosing one opens that menu under `»`.
  const overflowEntries: readonly MenuEntry[] = menus.slice(visible).map((menu, at) => ({
    kind: "item",
    id: `more-${menu.id}`,
    label: menu.label,
    disabled: menu.disabled,
    // State only (no refs): the chosen menu opens under `»`, which keeps standing for it.
    run: () => {
      setBarIndex(visible + at);
      setOpen({ index: visible + at, focus: "first" });
    },
  }));

  const canClose = active !== undefined && active.kind !== "status";
  const isMinimised = minimised.includes(activeKey);
  const openHidden = open !== null && open.index >= visible ? open : null;
  const hiddenMenu = openHidden === null ? undefined : menus[openHidden.index];

  // Frame_01: child icon at x5 y3; menus from x20 in fixed slots; child buttons 16x14 at y3, ending 2 px
  // from the right edge with a 2 px gap before close (R2.2, R5.2).
  return (
    <div ref={barRef} className="flex h-(--layout-menu) shrink-0 items-start bg-chrome-face font-chrome">
      <span className="ml-[5px] mt-[3px] flex shrink-0">
        {activeKind === undefined ? <span className="block size-3.5" /> : <ChildIcon kind={activeKind} />}
      </span>
      <div ref={rootRef} role="menubar" aria-label="Main menu" className="ml-px flex min-w-0">
        {menus.slice(0, visible).map((menu, i) => {
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
                aria-keyshortcuts={`Alt+${mnemonicOf(menu)}`}
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
                className={`${barButtonClass} ${SLOT_CLASS[i] ?? ""}`}
              >
                {menu.label.slice(0, menu.mnemonic)}
                <u>{menu.label.charAt(menu.mnemonic)}</u>
                {menu.label.slice(menu.mnemonic + 1)}
              </button>
              {isOpen ? popupFor(i, menu, open.focus) : null}
            </div>
          );
        })}
        {hasOverflow ? (
          <div className="relative">
            <button
              ref={overflowRef}
              type="button"
              role="menuitem"
              id="menu-overflow"
              aria-label="More menus"
              aria-haspopup="menu"
              aria-expanded={open !== null && (open.index === OVERFLOW || open.index >= visible)}
              aria-controls={open?.index === OVERFLOW ? "menu-overflow-list" : undefined}
              tabIndex={barIndex >= visible ? 0 : -1}
              onClick={(event) => {
                onBarClick(event, OVERFLOW);
              }}
              onKeyDown={(event) => {
                onBarKeyDown(event, OVERFLOW);
              }}
              className={`${barButtonClass} flex w-6 items-center justify-center px-0`}
            >
              <OverflowChevrons className="block size-4" />
            </button>
            {open?.index === OVERFLOW ? (
              <MenuPopup
                id="menu-overflow-list"
                align="right"
                label="More menus"
                entries={overflowEntries}
                initialFocus={open.focus}
                onClose={close}
                onSwitch={(direction) => {
                  openMenu(direction === 1 ? 0 : visible - 1, "first");
                }}
                onActivate={(run) => {
                  setOpen(null);
                  run();
                }}
              />
            ) : null}
            {openHidden !== null && hiddenMenu !== undefined
              ? popupFor(openHidden.index, hiddenMenu, openHidden.focus, "right")
              : null}
          </div>
        ) : null}
      </div>
      <div role="group" aria-label="Active window controls" className="ml-auto mr-0.5 mt-[3px] flex shrink-0">
        <CaptionButton
          kind="min"
          label="Minimise active window"
          onClick={() => {
            minimiseWindow(activeKey);
          }}
        />
        <CaptionButton
          kind="restore"
          label="Restore active window"
          title={isMinimised ? undefined : RESTORE_TITLE}
          description={isMinimised ? undefined : RESTORE_TITLE}
          inert={!isMinimised}
          onClick={() => {
            restoreWindow(activeKey);
          }}
        />
        <CaptionButton
          kind="close"
          label="Close active window"
          className="ml-0.5"
          disabled={!canClose}
          description={canClose ? undefined : "The Status window cannot be closed"}
          onClick={() => {
            closeWindow(activeKey);
          }}
        />
      </div>
    </div>
  );
}
