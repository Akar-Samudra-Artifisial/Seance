"use client";

import type { ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { statusCounts } from "../irc/index.js";
import type { ConnectionPhase } from "../irc/index.js";
import { useClientStore } from "../store/react.js";
import { hostOf } from "./TitleBar.js";

/** Sunken 1 px panel (shadow top/left, highlight bottom/right); text 6 px in; truncates. */
const panelClass =
  "min-w-0 basis-0 truncate whitespace-nowrap px-1.5 shadow-[inset_1px_1px_0_var(--color-chrome-shadow),inset_-1px_-1px_0_var(--color-chrome-highlight)]";

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
  // Counts are primitives, so a new chat line leaves the selection shallow-equal and skips the render.
  const counts = useClientStore(
    useShallow((s) => {
      const active = s.client.windows[s.client.activeKey];
      return statusCounts(s.client, active?.kind === "channel" ? "active" : "all");
    }),
  );

  const connection =
    phase === "registered"
      ? `Connected to ${hostOf(serverUrl)} as ${nick}${serverUrl.startsWith("wss:") ? " (TLS)" : ""}`
      : PHASE_TEXT[phase];
  const lagText = lag === null ? "lag –" : `lag ${lag.toFixed(2)}s`;

  // R1.6: at 1434 px the panels are 562, 140, 258 and the rest (461), 3 px apart. Grow factors in the
  // same ratio from a zero basis give those widths exactly and scale them on Medium (R11.3).
  // Compact keeps the connection and agents panels only (R11.4).
  return (
    <div
      role="status"
      className="mt-px flex h-(--layout-status) shrink-0 gap-[3px] bg-chrome-face px-0.5 font-chrome text-xs leading-(--layout-status) text-chrome-outline"
    >
      <span className={`${panelClass} grow-[562]`}>{connection}</span>
      <span aria-live="off" className={`${panelClass} hidden grow-[140] md:block`}>
        {lagText}
      </span>
      <span className={`${panelClass} grow-[258]`}>
        {`${String(counts.agents)} agents · ${String(counts.away)} away · ${String(counts.ops)} ops`}
      </span>
      <span aria-hidden="true" className={`${panelClass} hidden grow-[461] md:block`} />
    </div>
  );
}
