import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createClientStore } from "../store/client-store.js";
import { ClientStoreProvider } from "../store/react.js";
import type { SocketCloseInfo, WebSocketLike } from "../store/socket.js";
import { createClientStorage } from "../store/storage.js";
import { Shell } from "./ClientApp.js";

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

function renderShell(store: ReturnType<typeof setup>["store"]): void {
  render(
    <ClientStoreProvider store={store}>
      <Shell />
    </ClientStoreProvider>,
  );
}

describe("skip link", () => {
  it("moves focus to the Input_Line", () => {
    const { store } = setup();
    renderShell(store);
    const link = screen.getByRole("link", { name: "Skip to message input" });
    fireEvent.click(link);
    expect(document.activeElement).toBe(document.getElementById("input-line"));
  });
});

describe("unread announcement", () => {
  it("announces a window that becomes unread in a polite live region", () => {
    const { store, recv } = setup();
    renderShell(store);
    const region = screen.getByRole("status", { name: "Unread windows" });
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("");
    act(() => {
      recv(":bob!b@h PRIVMSG #dev :hello");
    });
    expect(region.textContent).toBe("New messages in #dev");
  });

  it("keeps the last message on further lines and announces only newly unread windows", () => {
    const { store, recv } = setup();
    renderShell(store);
    const region = screen.getByRole("status", { name: "Unread windows" });
    act(() => {
      recv(":bob!b@h PRIVMSG #dev :one");
    });
    act(() => {
      recv(":bob!b@h PRIVMSG #dev :two");
    });
    expect(region.textContent).toBe("New messages in #dev");
    act(() => {
      recv(":carol!c@h PRIVMSG alice :psst");
    });
    expect(region.textContent).toBe("New messages in carol");
  });
});
