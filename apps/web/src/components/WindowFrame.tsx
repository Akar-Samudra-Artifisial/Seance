"use client";

import type { ReactNode } from "react";
import type { Window } from "../irc/index.js";
import { useClientStore } from "../store/react.js";

/** Win95 MDI child: gradient title bar with the window name and a close control. */
export function WindowFrame(props: {
  readonly window: Window;
  readonly label: string;
  readonly children?: ReactNode;
}): ReactNode {
  const { window: win, label } = props;
  const setActiveWindow = useClientStore((s) => s.setActiveWindow);
  const closeWindow = useClientStore((s) => s.closeWindow);
  const closable = win.kind !== "status";
  return (
    <section aria-label={label} className="bevel-raised flex min-h-0 min-w-0 flex-1 flex-col bg-chrome-face p-0.5">
      <header
        onClick={() => {
          setActiveWindow(win.key);
        }}
        className="flex items-center justify-between bg-linear-to-r from-title-from to-title-to px-1"
      >
        <h2 className="font-title text-xl font-bold leading-tight text-chrome-highlight">{win.name}</h2>
        {closable ? (
          <button
            type="button"
            aria-label={`Close ${win.name}`}
            onClick={(event) => {
              event.stopPropagation();
              closeWindow(win.key);
            }}
            className="bevel-raised size-4 bg-chrome-face font-chrome text-xs leading-none text-chrome-outline focus-visible:outline-2 focus-visible:outline-chrome-highlight"
          >
            x
          </button>
        ) : null}
      </header>
      {props.children}
    </section>
  );
}
