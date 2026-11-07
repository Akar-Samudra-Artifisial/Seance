"use client";

import type { ReactNode } from "react";
import type { Window } from "../irc/index.js";
import { useClientStore } from "../store/react.js";
import { ChatBuffer } from "./ChatBuffer.js";
import { MdiChild } from "./MdiChild.js";

export function StatusWindow(props: { readonly window: Window }): ReactNode {
  const ownNick = useClientStore((s) => s.client.ownNick);
  return (
    <MdiChild window={props.window} label="Status window">
      <ChatBuffer label="Status messages" lines={props.window.lines} ownNick={ownNick} />
    </MdiChild>
  );
}
