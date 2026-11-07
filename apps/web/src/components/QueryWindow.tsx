"use client";

import type { ReactNode } from "react";
import type { Window } from "../irc/index.js";
import { useClientStore } from "../store/react.js";
import { ChatBuffer } from "./ChatBuffer.js";
import { MdiChild } from "./MdiChild.js";

export function QueryWindow(props: { readonly window: Window }): ReactNode {
  const ownNick = useClientStore((s) => s.client.ownNick);
  const { window: win } = props;
  return (
    <MdiChild window={win} label={`${win.name} window`}>
      <ChatBuffer label={`${win.name} messages`} lines={win.lines} ownNick={ownNick} />
    </MdiChild>
  );
}
