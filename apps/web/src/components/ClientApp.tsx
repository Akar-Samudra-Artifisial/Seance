"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type { Window } from "../irc/index.js";
import { createClientStore } from "../store/client-store.js";
import { ClientStoreProvider, useClientStore } from "../store/react.js";
import { createBrowserAudio } from "../store/audio.js";
import { createBrowserSocket } from "../store/socket.js";
import { createBrowserStorage } from "../store/storage.js";
import { ChannelWindow } from "./ChannelWindow.js";
import { ConnectDialog } from "./ConnectDialog.js";
import { InputLine } from "./InputLine.js";
import { MenuBar } from "./MenuBar.js";
import { Mdi } from "./Mdi.js";
import { QueryWindow } from "./QueryWindow.js";
import { SkipLink } from "./SkipLink.js";
import { StatusBar } from "./StatusBar.js";
import { UnreadAnnouncer } from "./UnreadAnnouncer.js";
import { Switchbar } from "./Switchbar.js";
import { Toolbar } from "./Toolbar.js";
import { StatusWindow } from "./StatusWindow.js";

export interface ClientAppProps {
  readonly defaultUrl: string;
  readonly allowedOrigins: readonly string[];
}

const EMPTY_STATUS: Window = {
  key: "status",
  kind: "status",
  name: "Status",
  lines: [],
  unread: false,
  mentioned: false,
};

const noopSubscribe = (): (() => void) => () => undefined;

/** Alt+1..9 → nth window; uses `code` because Alt changes `key` on some layouts. */
function windowIndexOf(event: KeyboardEvent): number | null {
  if (!event.altKey || event.ctrlKey || event.metaKey) return null;
  const match = /^(?:Digit|Numpad)([1-9])$/.exec(event.code) ?? /^([1-9])$/.exec(event.key);
  return match?.[1] === undefined ? null : Number(match[1]);
}

export function Shell(): ReactNode {
  const active = useClientStore((s) => s.client.windows[s.client.activeKey]);
  const activateByIndex = useClientStore((s) => s.activateByIndex);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const n = windowIndexOf(event);
      if (n === null) return;
      event.preventDefault();
      activateByIndex(n);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [activateByIndex]);
  const win = active ?? EMPTY_STATUS;
  return (
    <div className="flex h-full flex-col bg-chrome-face font-chrome">
      <SkipLink />
      <UnreadAnnouncer />
      <MenuBar />
      <Toolbar />
      <Mdi>
        {win.kind === "status" ? (
          <StatusWindow window={win} />
        ) : win.kind === "channel" ? (
          <ChannelWindow window={win} />
        ) : (
          <QueryWindow window={win} />
        )}
      </Mdi>
      <Switchbar />
      <InputLine />
      <StatusBar />
      <ConnectDialog />
    </div>
  );
}

export function ClientApp(props: ClientAppProps): ReactNode {
  const [store] = useState(() =>
    createClientStore({
      createSocket: createBrowserSocket,
      storage: createBrowserStorage(props.allowedOrigins),
      now: () => Date.now(),
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimeout: (handle) => {
        globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
      audio: createBrowserAudio(),
      defaultServerUrl: props.defaultUrl,
      allowedOrigins: props.allowedOrigins,
    }),
  );
  // Close the socket and clear the paste timer when the app unmounts.
  useEffect(() => {
    return () => {
      store.getState().dispose();
    };
  }, [store]);
  // Stored nick and URL exist only in the browser; render the stateful tree after hydration.
  const mounted = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
  if (!mounted) return null;
  return (
    <ClientStoreProvider store={store}>
      <Shell />
    </ClientStoreProvider>
  );
}
