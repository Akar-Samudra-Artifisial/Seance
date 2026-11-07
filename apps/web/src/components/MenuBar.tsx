"use client";

import type { ReactNode } from "react";
import { useClientStore } from "../store/react.js";

const itemClass =
  "px-2 text-sm text-chrome-outline hover:bg-title-from hover:text-chrome-highlight focus-visible:outline-2 focus-visible:outline-chrome-outline";

export function MenuBar(): ReactNode {
  const activeKey = useClientStore((s) => s.client.activeKey);
  const closeWindow = useClientStore((s) => s.closeWindow);
  const quit = useClientStore((s) => s.quit);
  const mentionSound = useClientStore((s) => s.ui.mentionSound);
  const setMentionSound = useClientStore((s) => s.setMentionSound);
  return (
    <div role="menubar" aria-label="Main menu" className="flex bg-chrome-face font-chrome">
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          closeWindow(activeKey);
        }}
        className={itemClass}
      >
        Close window
      </button>
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={mentionSound}
        onClick={() => {
          setMentionSound(!mentionSound);
        }}
        className={itemClass}
      >
        Mention sound: {mentionSound ? "on" : "off"}
      </button>
      <button type="button" role="menuitem" onClick={quit} className={itemClass}>
        Quit
      </button>
    </div>
  );
}
