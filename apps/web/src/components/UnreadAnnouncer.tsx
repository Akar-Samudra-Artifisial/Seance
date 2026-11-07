"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import type { Window } from "../irc/index.js";
import { useClientStore } from "../store/react.js";

interface Snapshot {
  readonly windows: Readonly<Record<string, Window>>;
  readonly unread: ReadonlySet<string>;
  readonly message: string;
}

function unreadKeys(windows: Readonly<Record<string, Window>>): ReadonlySet<string> {
  const unread = new Set<string>();
  for (const key of Object.keys(windows)) if (windows[key]?.unread === true) unread.add(key);
  return unread;
}

/** Screen-reader-only live region announcing each window that newly becomes unread. */
export function UnreadAnnouncer(): ReactNode {
  const windows = useClientStore((s) => s.client.windows);
  const [snapshot, setSnapshot] = useState<Snapshot>(() => ({
    windows,
    unread: unreadKeys(windows),
    message: "",
  }));
  let current = snapshot;
  if (snapshot.windows !== windows) {
    // Derive the next snapshot during render from the previous one (no effect needed).
    const unread = unreadKeys(windows);
    const fresh: string[] = [];
    for (const key of unread) {
      if (!snapshot.unread.has(key)) fresh.push(windows[key]?.name ?? key);
    }
    current = {
      windows,
      unread,
      message: fresh.length > 0 ? `New messages in ${fresh.join(", ")}` : snapshot.message,
    };
    setSnapshot(current);
  }
  return (
    <div role="status" aria-label="Unread windows" aria-live="polite" aria-atomic="true" className="sr-only">
      {current.message}
    </div>
  );
}
