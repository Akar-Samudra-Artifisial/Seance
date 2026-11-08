"use client";
// Fixture shell for the screenshot tests (web-client-pixel-match R13): the real `Shell`, with a
// store fed by an in-memory socket and a fixed clock. No network: the socket never connects.

import { useEffect, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { Shell } from "../components/ClientApp.js";
import { createClientStore } from "../store/client-store.js";
import type { ClientStore } from "../store/client-store.js";
import { ClientStoreProvider } from "../store/react.js";
import type { SocketCloseInfo, WebSocketLike } from "../store/socket.js";
import { createClientStorage } from "../store/storage.js";
import { FIGMA_01_AFTER, FIGMA_01_MAIN, FIXTURE_MARKER, stepTime } from "./figma-01-main.js";
import type { FixtureScript, FixtureStep } from "./figma-01-main.js";

/** Socket that records what the client sends and lets the fixture push server lines. */
class FixtureSocket implements WebSocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((e: { readonly data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: SocketCloseInfo) => void) | null = null;
  send(): void {}
  close(): void {}
}

type StoreApi = ReturnType<typeof createClientStore>;

const noopSubscribe = (): (() => void) => () => undefined;

/** Builds a store in the Frame_01 state. Exported for the unit test. */
export function createFixtureStore(script: FixtureScript = FIGMA_01_MAIN): StoreApi {
  const socket = new FixtureSocket();
  let clock = stepTime(script.steps[0]?.at ?? "23:38:00");
  const store = createClientStore({
    createSocket: () => socket,
    storage: createClientStorage({ getItem: () => null, setItem: () => undefined }, [script.serverUrl]),
    now: () => clock,
    // Timers never fire: no ping, no reconnect, no paste timeout in a still picture.
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    defaultServerUrl: script.serverUrl,
    allowedOrigins: [script.serverUrl],
  });
  const feed = (steps: readonly FixtureStep[]): void => {
    for (const step of steps) {
      clock = stepTime(step.at);
      socket.onmessage?.({ data: `${step.line}\r\n` });
    }
  };
  store.getState().connect({ nick: script.nick, serverUrl: script.serverUrl, password: undefined });
  socket.onopen?.();
  feed(script.steps);
  store.getState().submitInput("/query coder");
  store.getState().setActiveWindow(script.active);
  feed(FIGMA_01_AFTER);
  for (const key of script.minimised) store.getState().minimiseWindow(key);
  store.getState().setActiveWindow(script.active);
  store.setState((s: ClientStore) => ({ ui: { ...s.ui, lagSeconds: script.lagSeconds } }));
  // Frame_01 shows a typed, unsent command in the input line.
  if (script.inputDraft !== "") store.getState().insertCommand(script.inputDraft);
  return store;
}

/** The fixture page body: same code path as the product, only the store input differs. */
export function FixtureShell(): ReactNode {
  const [store] = useState(() => createFixtureStore());
  // Like ClientApp: render after hydration, so timestamps use the browser's time zone.
  const mounted = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
  // Lets the screenshot spec wait for a fully rendered fixture.
  useEffect(() => {
    if (mounted) document.documentElement.dataset["fixture"] = FIXTURE_MARKER;
  }, [mounted]);
  if (!mounted) return null;
  return (
    <ClientStoreProvider store={store}>
      <Shell />
    </ClientStoreProvider>
  );
}
