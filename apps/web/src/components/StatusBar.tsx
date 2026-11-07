"use client";

import type { ReactNode } from "react";
import { statusCounts } from "../irc/index.js";
import type { ConnectionPhase } from "../irc/index.js";
import { useClientStore } from "../store/react.js";
import { hostOf } from "./TitleBar.js";

const panelClass = "bevel-sunken whitespace-nowrap px-1";

const PHASE_TEXT: Readonly<Record<Exclude<ConnectionPhase, "registered">, string>> = {
  disconnected: "Disconnected",
  connecting: "Connecting…",
  registering: "Connecting…",
  failed: "Connection failed",
};

/** Win95 status bar (R6): connection, lag, agent counts and an empty filler. */
export function StatusBar(): ReactNode {
  const phase = useClientStore((s) => s.client.phase);
  const nick = useClientStore((s) => s.client.ownNick);
  const serverUrl = useClientStore((s) => s.ui.serverUrl);
  const lag = useClientStore((s) => s.ui.lagSeconds);
  const client = useClientStore((s) => s.client);
  const active = client.windows[client.activeKey];
  const counts = statusCounts(client, active?.kind === "channel" ? "active" : "all");

  const connection =
    phase === "registered"
      ? `Connected to ${hostOf(serverUrl)} as ${nick}${serverUrl.startsWith("wss:") ? " (TLS)" : ""}`
      : PHASE_TEXT[phase];
  const lagText = lag === null ? "lag –" : `lag ${lag.toFixed(2)}s`;

  return (
    <div role="status" className="flex gap-0.5 bg-chrome-face px-0.5 py-0.5 font-chrome text-xs text-chrome-outline">
      <span className={`${panelClass} flex-[2]`}>{connection}</span>
      <span aria-live="off" className={`${panelClass} flex-1`}>
        {lagText}
      </span>
      <span className={`${panelClass} flex-1`}>
        {`${String(counts.agents)} agents · ${String(counts.away)} away · ${String(counts.ops)} ops`}
      </span>
      <span aria-hidden="true" className={`${panelClass} flex-1`} />
    </div>
  );
}
