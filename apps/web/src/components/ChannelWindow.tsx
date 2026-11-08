"use client";

import type { ReactNode } from "react";
import type { Window } from "../irc/index.js";
import { useClientStore } from "../store/react.js";
import { ChatBuffer } from "./ChatBuffer.js";
import { useCompact } from "./layout-hooks.js";
import { MdiChild } from "./MdiChild.js";
import { NickList } from "./NickList.js";
import { NickOverlay } from "./NickOverlay.js";
import { TopicBar } from "./TopicBar.js";

/**
 * Channel window: full-width topic field, then chat pane and nick list 2 px below it (R1.1).
 * In Compact the nick list is replaced by the toolbar-driven overlay (R11.4).
 */
export function ChannelWindow(props: { readonly window: Window }): ReactNode {
  const ownNick = useClientStore((s) => s.client.ownNick);
  const away = useClientStore((s) => s.client.away);
  const overlayOpen = useClientStore((s) => s.ui.nickOverlayOpen);
  const compact = useCompact();
  const { window: win } = props;
  return (
    <MdiChild window={win} label={`${win.name} window`}>
      <TopicBar channel={win.name} modes={win.modes} topic={win.topic} />
      <div className="relative mt-0.5 flex min-h-0 min-w-0 flex-1">
        <ChatBuffer label={`${win.name} messages`} lines={win.lines} members={win.members} ownNick={ownNick} />
        {compact ? (
          overlayOpen ? (
            <NickOverlay channel={win.name} members={win.members} away={away} exorcised={win.exorcised} />
          ) : null
        ) : (
          <NickList channel={win.name} members={win.members} away={away} exorcised={win.exorcised} />
        )}
      </div>
    </MdiChild>
  );
}
