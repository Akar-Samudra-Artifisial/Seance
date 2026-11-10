"use client";

import type { ReactNode } from "react";
import { creditsTotal } from "../irc/index.js";
import { CreditsCandleSlice } from "../icons/index.js";
import { useClientStore } from "../store/react.js";

/**
 * Credits panel at the right of the Switchbar (R8.3): a 160x22 sunken field with the candle slice
 * at 7,6 and `credits: <value>` in Plex Mono 13 from x22, the value bold with two decimals (a typical
 * prompt costs 0.01 to 0.05 credits, so one decimal showed 0.0 for all normal use).
 * Compact hides the label and keeps the candle and the value (R11.4).
 */
export function CreditsCounter(): ReactNode {
  const total = useClientStore((s) => creditsTotal(s.client));
  return (
    <div
      role="status"
      aria-label="Credits used by agents"
      className="bevel-field relative ml-1 mr-0.5 h-[22px] shrink-0 bg-chrome-face pl-[22px] pr-2 font-chat text-[13px] leading-[22px] text-chrome-outline md:w-40"
    >
      <CreditsCandleSlice className="absolute left-[7px] top-1.5 block size-2.5" />
      <span className="hidden md:inline">credits: </span>
      <span className="font-bold">{total.toFixed(2)}</span>
    </div>
  );
}
