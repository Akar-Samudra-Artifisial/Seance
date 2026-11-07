import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createClientStore } from "../store/client-store.js";
import { ClientStoreProvider } from "../store/react.js";
import type { SocketCloseInfo, WebSocketLike } from "../store/socket.js";
import { createClientStorage } from "../store/storage.js";
import { Shell } from "./ClientApp.js";
import { MinimisedTray } from "./MinimisedTray.js";

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
  recv(":alice!a@h JOIN #ops");
  return { store, recv };
}

describe("MinimisedTray", () => {
  it("renders nothing when no window is minimised", () => {
    const { store } = setup();
    render(
      <ClientStoreProvider store={store}>
        <MinimisedTray />
      </ClientStoreProvider>,
    );
    expect(screen.queryByRole("region", { name: "Minimised windows" })).toBeNull();
  });

  it("shows a bar per minimised window; bar and Restore control both restore", () => {
    const { store } = setup();
    store.getState().minimiseWindow("c:#dev");
    store.getState().minimiseWindow("status");
    render(
      <ClientStoreProvider store={store}>
        <MinimisedTray />
      </ClientStoreProvider>,
    );
    const bars = screen.getAllByTestId("minimised-bar");
    expect(bars).toHaveLength(2);
    const status = bars[1] as HTMLElement;
    expect((within(status).getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(true);
    const dev = bars[0] as HTMLElement;
    expect((within(dev).getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(false);
    expect(dev.querySelector("[style]")).toBeNull();
    fireEvent.click(within(dev).getByRole("button", { name: "Restore" }));
    expect(store.getState().ui.minimised).toEqual(["status"]);
    expect(store.getState().client.activeKey).toBe("c:#dev");
    fireEvent.click(within(status).getByRole("button", { name: /^Restore Status/ }));
    expect(store.getState().ui.minimised).toEqual([]);
    expect(store.getState().client.activeKey).toBe("status");
  });

  it("closing a bar closes the window", () => {
    const { store, recv } = setup();
    store.getState().minimiseWindow("c:#ops");
    render(
      <ClientStoreProvider store={store}>
        <MinimisedTray />
      </ClientStoreProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    // A channel closes when the Ircd echoes our PART.
    recv(":alice!a@h PART #ops");
    expect(store.getState().client.windows["c:#ops"]).toBeUndefined();
    expect(store.getState().ui.minimised).toEqual([]);
  });

  it("sits between the Input_Line and the Switchbar in the Shell", () => {
    const { store } = setup();
    store.getState().minimiseWindow("c:#dev");
    render(
      <ClientStoreProvider store={store}>
        <Shell />
      </ClientStoreProvider>,
    );
    const tray = screen.getByRole("region", { name: "Minimised windows" });
    const input = screen.getByRole("textbox");
    const switchbar = screen.getByRole("navigation", { name: "Windows" });
    expect(input.compareDocumentPosition(tray) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(tray.compareDocumentPosition(switchbar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
