import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createClientStore } from "../store/client-store.js";
import { ClientStoreProvider } from "../store/react.js";
import type { SocketCloseInfo, WebSocketLike } from "../store/socket.js";
import { createClientStorage } from "../store/storage.js";
import { Shell } from "./ClientApp.js";
import { Switchbar } from "./Switchbar.js";

afterEach(cleanup);

const ORIGIN = "ws://127.0.0.1:6680";

class FakeSocket implements WebSocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((e: { readonly data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: SocketCloseInfo) => void) | null = null;
  send(): void {}
  close(): void {}
}

function setup() {
  const socket = new FakeSocket();
  const store = createClientStore({
    createSocket: () => socket,
    storage: createClientStorage({ getItem: () => null, setItem: () => undefined }, [ORIGIN]),
    now: () => 1000,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    defaultServerUrl: ORIGIN,
    allowedOrigins: [ORIGIN],
  });
  store.getState().connect({ nick: "alice", serverUrl: ORIGIN, password: undefined });
  socket.onopen?.();
  const recv = (line: string): void => socket.onmessage?.({ data: `${line}\r\n` });
  recv(":srv 001 alice :Welcome");
  recv(":alice!a@h JOIN #dev");
  recv(":srv 366 alice #dev :End of /NAMES list");
  store.getState().setActiveWindow("status");
  return { store, recv };
}

describe("Switchbar", () => {
  it("names each window with its active, unread and mention state", () => {
    const { store, recv } = setup();
    recv(":bob!b@h PRIVMSG #dev :hello");
    recv(":bob!b@h PRIVMSG alice :ping");
    recv(":bob!b@h PRIVMSG #dev :alice look");
    render(
      <ClientStoreProvider store={store}>
        <Switchbar />
      </ClientStoreProvider>,
    );
    const names = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(names[0]).toBe("Status (active)");
    expect(names[1]).toBe("#dev (mentioned, unread)");
    expect(names[2]).toBe("bob (unread)");
  });

  it("activates a window on click and clears its marker", () => {
    const { store, recv } = setup();
    recv(":bob!b@h PRIVMSG #dev :hello");
    render(
      <ClientStoreProvider store={store}>
        <Switchbar />
      </ClientStoreProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "#dev (unread)" }));
    expect(store.getState().client.activeKey).toBe("c:#dev");
    expect(screen.getByRole("button", { name: "#dev (active)" })).toBeDefined();
  });
});

describe("window shortcuts", () => {
  it("Alt+2 activates the second window", () => {
    const { store } = setup();
    render(
      <ClientStoreProvider store={store}>
        <Shell />
      </ClientStoreProvider>,
    );
    fireEvent.keyDown(document, { key: "™", code: "Digit2", altKey: true });
    expect(store.getState().client.activeKey).toBe("c:#dev");
  });

  it("closing a query window via its close control removes it", () => {
    const { store } = setup();
    store.getState().submitInput("/query bob");
    render(
      <ClientStoreProvider store={store}>
        <Shell />
      </ClientStoreProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close bob" }));
    expect(store.getState().client.windows["q:bob"]).toBeUndefined();
  });
});
