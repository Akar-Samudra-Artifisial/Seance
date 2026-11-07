"use client";

import type { ReactNode } from "react";
import type { Window } from "../irc/index.js";
import { ChatBuffer } from "./ChatBuffer.js";
import { WindowFrame } from "./WindowFrame.js";

export function QueryWindow(props: { readonly window: Window }): ReactNode {
  const { window: win } = props;
  return (
    <WindowFrame window={win} label={`${win.name} window`}>
      <ChatBuffer label={`${win.name} messages`} lines={win.lines} />
    </WindowFrame>
  );
}
