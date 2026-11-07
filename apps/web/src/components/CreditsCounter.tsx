"use client";

import type { ReactNode } from "react";
import { creditsTotal } from "../irc/index.js";
import { useClientStore } from "../store/react.js";

/** Sunken panel at the right of the Switchbar: credits used by all agents, one decimal. */
export function CreditsCounter(): ReactNode {
  const total = useClientStore((s) => creditsTotal(s.client));
  return (
    <div
      role="status"
      aria-label="Credits used by agents"
      className="bevel-sunken ml-auto flex h-5.5 shrink-0 items-center gap-1.5 bg-ghost-bg px-2 font-chat text-[13px] text-ghost-text"
    >
      <span aria-hidden="true" className="inline-block size-2 rounded-full bg-ghost-orange" />
      <span>credits: {total.toFixed(1)}</span>
    </div>
  );
}
