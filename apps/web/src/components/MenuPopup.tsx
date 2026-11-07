"use client";
import { useEffect, useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";

export type MenuEntry =
  | { readonly kind: "separator"; readonly id: string }
  | {
      readonly kind: "item";
      readonly id: string;
      readonly label: string;
      /** Unsupported or unavailable: rendered `aria-disabled`, inert when activated. */
      readonly disabled: boolean;
      /** Set for checkbox items; the item then gets `role="menuitemcheckbox"`. */
      readonly checked?: boolean;
      readonly run: () => void;
    };

export type InitialFocus = "first" | "last" | "menu";

export interface MenuPopupProps {
  readonly id: string;
  readonly label: string;
  readonly entries: readonly MenuEntry[];
  readonly initialFocus: InitialFocus;
  /** Escape or Tab: close the menu; `restoreFocus` returns focus to the menu button. */
  readonly onClose: (restoreFocus: boolean) => void;
  /** ArrowLeft / ArrowRight: open the neighbouring menu. */
  readonly onSwitch: (direction: -1 | 1) => void;
  /** Enter, Space or click on an enabled item. */
  readonly onActivate: (run: () => void) => void;
}

const itemClass =
  "flex w-full items-center gap-1 px-4 py-0.5 text-left font-chrome text-xs text-chrome-outline hover:bg-title-from hover:text-chrome-highlight focus:bg-title-from focus:text-chrome-highlight aria-disabled:text-chrome-shadow aria-disabled:hover:bg-chrome-face aria-disabled:hover:text-chrome-shadow aria-disabled:focus:bg-title-from aria-disabled:focus:text-chrome-face";

/** Win95 drop-down list: `role="menu"` with roving focus, arrow keys, Home/End and type-ahead. */
export function MenuPopup(props: MenuPopupProps): ReactNode {
  const { entries, initialFocus, onClose, onSwitch, onActivate } = props;
  const menuRef = useRef<HTMLDivElement>(null);

  const buttons = (): HTMLButtonElement[] =>
    Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button[role^='menuitem']") ?? []);

  useEffect(() => {
    const list = buttons();
    const target =
      initialFocus === "first" ? list[0] : initialFocus === "last" ? list[list.length - 1] : menuRef.current;
    target?.focus();
    // Focus is placed once, when the popup opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const move = (to: (index: number, count: number) => number): void => {
    const list = buttons();
    if (list.length === 0) return;
    const at = list.findIndex((b) => b === document.activeElement);
    list[to(at, list.length)]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move((at, n) => (at + 1) % n);
        return;
      case "ArrowUp":
        event.preventDefault();
        move((at, n) => (at <= 0 ? n - 1 : at - 1));
        return;
      case "Home":
        event.preventDefault();
        move(() => 0);
        return;
      case "End":
        event.preventDefault();
        move((_at, n) => n - 1);
        return;
      case "ArrowLeft":
        event.preventDefault();
        onSwitch(-1);
        return;
      case "ArrowRight":
        event.preventDefault();
        onSwitch(1);
        return;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        onClose(true);
        return;
      case "Tab":
        onClose(false);
        return;
      default:
    }
    // Type-ahead: a printable letter jumps to the next item starting with it.
    if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const letter = event.key.toLowerCase();
      const list = buttons();
      const at = list.findIndex((b) => b === document.activeElement);
      const ordered = [...list.slice(at + 1), ...list.slice(0, at + 1)];
      const hit = ordered.find((b) => (b.textContent ?? "").trim().toLowerCase().startsWith(letter));
      if (hit !== undefined) {
        event.preventDefault();
        hit.focus();
      }
    }
  };

  return (
    <div
      ref={menuRef}
      id={props.id}
      role="menu"
      aria-label={props.label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="bevel-raised absolute left-0 top-full z-20 min-w-44 bg-chrome-face p-0.5"
    >
      {props.entries.map((entry) =>
        entry.kind === "separator" ? (
          <div key={entry.id} role="separator" className="my-0.5 h-0.5 bevel-sunken" />
        ) : (
          <button
            key={entry.id}
            type="button"
            role={entry.checked === undefined ? "menuitem" : "menuitemcheckbox"}
            aria-checked={entry.checked}
            aria-disabled={entry.disabled ? "true" : undefined}
            tabIndex={-1}
            onClick={() => {
              if (entry.disabled) return;
              onActivate(entry.run);
            }}
            className={itemClass}
          >
            <span aria-hidden="true" className="w-3 shrink-0">
              {entry.checked === true ? "✓" : ""}
            </span>
            {entry.label}
          </button>
        ),
      )}
    </div>
  );
}
