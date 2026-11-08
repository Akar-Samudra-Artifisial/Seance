import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createClientStore } from "../store/client-store.js";
import { ClientStoreProvider } from "../store/react.js";
import type { SocketCloseInfo, WebSocketLike } from "../store/socket.js";
import { createClientStorage } from "../store/storage.js";
import { StatusBar } from "./StatusBar.js";

afterEach(cleanup);

const WS = "ws://127.0.0.1:6680";
const WSS = "wss://irc.example.org:6697";

class FakeSocket implements WebSocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((e: { readonly data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: SocketCloseInfo) => void) | null = null;
  send(): void {}
  close(): void {}
}

function setup(url: string, register: boolean) {
  const socket = new FakeSocket();
  const store = createClientStore({
    createSocket: () => socket,
    storage: createClientStorage({ getItem: () => null, setItem: () => undefined }, [WS, WSS]),
    now: () => 1000,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    defaultServerUrl: WS,
    allowedOrigins: [WS, WSS],
  });
  const recv = (line: string): void => socket.onmessage?.({ data: `${line}\r\n` });
  render(
    <ClientStoreProvider store={store}>
      <StatusBar />
    </ClientStoreProvider>,
  );
  return { store, socket, recv, connect: () => {
    store.getState().connect({ nick: "alice", serverUrl: url, password: undefined });
    socket.onopen?.();
    if (register) recv(":srv 001 alice :Welcome");
  } };
}

describe("StatusBar", () => {
  it("reads Disconnected before connecting, with lag and agent placeholders", () => {
    setup(WS, false);
    const bar = screen.getByRole("status");
    expect(bar.textContent).toContain("Disconnected");
    expect(bar.textContent).toContain("lag –");
    expect(bar.textContent).toContain("0 agents · 0 away · 0 ops");
  });

  it("reads Connected to host:port as nick when registered", () => {
    const t = setup(WS, true);
    act(() => {
      t.connect();
    });
    expect(screen.getByRole("status").textContent).toContain("Connected to 127.0.0.1:6680 as alice");
    expect(screen.getByRole("status").textContent).not.toContain("(TLS)");
  });

  // pixel-match follow-up: Frame_01 reads `Connected to <host>:<port> (TLS) as <nick>`; the TLS mark
  // moved from the end to after the host on purpose (supersedes web-client-polish R6.2 wording).
  it("marks (TLS) after the host for wss and shows lag with two decimals", () => {
    const t = setup(WSS, true);
    act(() => {
      t.connect();
    });
    expect(screen.getByRole("status").textContent).toContain("Connected to irc.example.org:6697 (TLS) as alice");
    expect(document.querySelector('[aria-live="off"]')?.textContent).toBe("lag –");
  });

  it("reads Connecting… while the socket opens", () => {
    const t = setup(WS, false);
    act(() => {
      t.store.getState().connect({ nick: "alice", serverUrl: WS, password: undefined });
    });
    expect(screen.getByRole("status").textContent).toContain("Connecting…");
  });
});
