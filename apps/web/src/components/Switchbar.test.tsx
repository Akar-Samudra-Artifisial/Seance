import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

describe("Switchbar layout and CreditsCounter", () => {
  it("keeps every window in the bar and shows the credits total as a named status", () => {
    const { store, recv } = setup();
    store.getState().minimiseWindow("c:#dev");
    recv(":srv 320 alice coder :credits: #dev 9.60 / total 12.00");
    const { container } = render(
      <ClientStoreProvider store={store}>
        <Switchbar />
      </ClientStoreProvider>,
    );
    expect(screen.getAllByRole("button")).toHaveLength(2);
    const counter = screen.getByRole("status", { name: "Credits used by agents" });
    expect(counter.textContent).toBe("credits: 12.0");
    expect(container.querySelector("[style]")).toBeNull();
  });

  it("clears credits only when connecting to a different server", () => {
    const other = "ws://127.0.0.1:6681";
    const socket = new FakeSocket();
    const store = createClientStore({
      createSocket: () => socket,
      storage: createClientStorage({ getItem: () => null, setItem: () => undefined }, [ORIGIN, other]),
      now: () => 1000,
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      defaultServerUrl: ORIGIN,
      allowedOrigins: [ORIGIN, other],
    });
    store.getState().connect({ nick: "alice", serverUrl: ORIGIN, password: undefined });
    socket.onopen?.();
    socket.onmessage?.({ data: ":srv 320 alice coder :credits: #dev 1.00 / total 5.00\r\n" });
    expect(Object.keys(store.getState().client.credits)).toHaveLength(1);
    store.getState().connect({ nick: "alice", serverUrl: ORIGIN, password: undefined });
    expect(Object.keys(store.getState().client.credits)).toHaveLength(1);
    store.getState().connect({ nick: "alice", serverUrl: other, password: undefined });
    expect(Object.keys(store.getState().client.credits)).toHaveLength(0);
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
    // pixel-match R2.1/R2.2: the child has no title bar any more; its close button now sits at the
    // right of the menu bar ("Close active window"), outside the window region.
    expect(within(screen.getByRole("region", { name: "bob window" })).queryByRole("button")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close active window" }));
    expect(store.getState().client.windows["q:bob"]).toBeUndefined();
  });
});
