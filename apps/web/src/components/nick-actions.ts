"use client";

import { keyOf } from "../irc/casemap.js";
import type { Member } from "../irc/index.js";
import { useClientStore } from "../store/react.js";
import type { NickAction } from "./NickList.js";

/** The command a nick-list action stands for; the commands go through the same parser as typed input. */
export function nickActionCommand(action: NickAction, channel: string, nick: string): string {
  switch (action) {
    case "whois":
      return `/whois ${nick}`;
    case "query":
      return `/query ${nick}`;
    case "voice":
      return `/mode ${channel} +v ${nick}`;
    case "devoice":
      return `/mode ${channel} -v ${nick}`;
    case "kick":
      return `/kick ${channel} ${nick}`;
  }
}

/** Handlers for the interactive nick list of `channel` (audit 10.5): who may moderate, and what an action does. */
export function useNickActions(
  channel: string,
  members: Readonly<Record<string, Member>> | undefined,
): { readonly onAction: (action: NickAction, nick: string) => void; readonly canModerate: boolean } {
  const submitInput = useClientStore((s) => s.submitInput);
  const ownNick = useClientStore((s) => s.client.ownNick);
  const own = ownNick === "" ? undefined : Object.values(members ?? {}).find((m) => keyOf(m.nick) === keyOf(ownNick));
  return {
    canModerate: own?.op === true,
    onAction: (action, nick) => {
      submitInput(nickActionCommand(action, channel, nick));
    },
  };
}
