"use client";

import type { ReactNode } from "react";
import { useClientStore } from "../store/react.js";

export function StatusBar(): ReactNode {
  const phase = useClientStore((s) => s.client.phase);
  const nick = useClientStore((s) => s.client.ownNick);
  const activeName = useClientStore((s) => s.client.windows[s.client.activeKey]?.name ?? "Status");
  return (
    <div role="status" className="bevel-sunken flex gap-4 bg-chrome-face px-2 font-chrome text-sm text-chrome-outline">
      <span>{phase}</span>
      <span>{nick === "" ? "no nick" : nick}</span>
      <span>{activeName}</span>
    </div>
  );
}
