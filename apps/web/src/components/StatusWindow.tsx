"use client";

import type { ReactNode } from "react";
import type { Window } from "../irc/index.js";
import { ChatBuffer } from "./ChatBuffer.js";
import { WindowFrame } from "./WindowFrame.js";

export function StatusWindow(props: { readonly window: Window }): ReactNode {
  return (
    <WindowFrame window={props.window} label="Status window">
      <ChatBuffer label="Status messages" lines={props.window.lines} />
    </WindowFrame>
  );
}
