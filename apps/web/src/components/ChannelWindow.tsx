"use client";

import type { ReactNode } from "react";
import type { Window } from "../irc/index.js";
import { ChatBuffer } from "./ChatBuffer.js";
import { NickList } from "./NickList.js";
import { TopicBar } from "./TopicBar.js";
import { WindowFrame } from "./WindowFrame.js";

export function ChannelWindow(props: { readonly window: Window }): ReactNode {
  const { window: win } = props;
  return (
    <WindowFrame window={win} label={`${win.name} window`}>
      <TopicBar topic={win.topic} />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ChatBuffer label={`${win.name} messages`} lines={win.lines} />
        </div>
        <NickList channel={win.name} members={win.members} />
      </div>
    </WindowFrame>
  );
}
