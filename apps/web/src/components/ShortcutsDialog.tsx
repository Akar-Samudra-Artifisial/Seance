"use client";

import type { ReactNode } from "react";
import { SHORTCUTS, pasteNote } from "../shortcuts/shortcuts.js";
import type { ShortcutGroup } from "../shortcuts/shortcuts.js";
import { useClientStore } from "../store/react.js";
import { Dialog } from "./Dialog.js";

const GROUPS: readonly ShortcutGroup[] = ["Windows", "Menus", "Toolbar", "Input line", "Dialogs"];

/** Help → Keyboard shortcuts. Every row comes from `SHORTCUTS`, the registry the handlers use. */
export function ShortcutsDialog(): ReactNode {
  const open = useClientStore((s) => s.ui.shortcutsOpen);
  const close = useClientStore((s) => s.closeShortcuts);
  if (!open) return null;
  return (
    <Dialog title="Keyboard shortcuts" titleId="shortcuts-title" onClose={close} className="max-h-full w-[540px]">
      {/* Focusable so keyboard users can scroll the list (axe: scrollable-region-focusable). */}
      <div
        tabIndex={0}
        role="region"
        aria-label="Shortcut list"
        className="win95-scroll-y bevel-sunken mx-2 mt-2 min-h-0 flex-1 bg-ghost-bg p-2 text-ghost-text focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ghost-orange"
      >
        {GROUPS.map((group) => (
          <section key={group} aria-labelledby={`shortcuts-${group}`} className="mb-2">
            <h3 id={`shortcuts-${group}`} className="mb-0.5 font-bold text-ghost-orange">
              {group}
            </h3>
            <dl className="grid grid-cols-[11rem_1fr] gap-x-2 gap-y-0.5">
              {SHORTCUTS.filter((s) => s.group === group).map((s) => (
                <div key={s.id} data-shortcut={s.id} className="contents">
                  <dt>
                    <kbd className="font-chat text-[13px]">{s.keys}</kbd>
                  </dt>
                  <dd>{s.action}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        <p data-testid="paste-note">{pasteNote()}</p>
      </div>
      <div className="flex shrink-0 justify-end px-2 py-2">
        <button
          type="button"
          data-autofocus
          onClick={close}
          className="hit-target bevel-button active:bevel-button-pressed h-[25px] w-[84px] bg-chrome-face text-xs font-bold text-chrome-outline focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-chrome-outline"
        >
          Close
        </button>
      </div>
    </Dialog>
  );
}
