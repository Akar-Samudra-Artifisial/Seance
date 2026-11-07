"use client";

import type { ReactNode } from "react";
import type { Window } from "../irc/index.js";
import { useClientStore } from "../store/react.js";
import { ChatBuffer } from "./ChatBuffer.js";
import { NickList } from "./NickList.js";
import { TopicBar } from "./TopicBar.js";
import { MdiChild } from "./MdiChild.js";

export function ChannelWindow(props: { readonly window: Window }): ReactNode {
  const ownNick = useClientStore((s) => s.client.ownNick);
  const away = useClientStore((s) => s.client.away);
  const { window: win } = props;
  return (
    <MdiChild window={win} label={`${win.name} window`}>
      <TopicBar channel={win.name} modes={win.modes} topic={win.topic} />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <ChatBuffer label={`${win.name} messages`} lines={win.lines} members={win.members} ownNick={ownNick} />
        </div>
        <NickList channel={win.name} members={win.members} away={away} exorcised={win.exorcised} />
      </div>
    </MdiChild>
  );
}
