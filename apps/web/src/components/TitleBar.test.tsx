import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClientStore } from "../store/client-store.js";
import { ClientStoreProvider } from "../store/react.js";
import type { SocketCloseInfo, WebSocketLike } from "../store/socket.js";
import { createClientStorage } from "../store/storage.js";
import { TitleBar, hostOf } from "./TitleBar.js";

afterEach(cleanup);

const ORIGIN = "ws://127.0.0.1:6680";

class FakeSocket implements WebSocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((e: { readonly data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: SocketCloseInfo) => void) | null = null;
  readonly sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
}

function setup(register: boolean) {
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
  if (register) recv(":srv 001 alice :Welcome");
  render(
    <ClientStoreProvider store={store}>
      <TitleBar />
    </ClientStoreProvider>,
  );
  return { store, socket, recv };
}

describe("TitleBar", () => {
  it("shows the status title and mirrors it in document.title", () => {
    setup(true);
    const expected = "Séance — [Status: alice on 127.0.0.1:6680]";
    expect(screen.getByTestId("title-bar").textContent).toContain(expected);
    expect(document.title).toBe(expected);
    expect(screen.getByTestId("title-bar").dataset["active"]).toBe("true");
  });

  it("renders the topic as text through the formatter", () => {
    const { store, recv } = setup(true);
    recv(":alice!a@h JOIN #dev");
    recv(":srv 332 alice #dev :\x02<b>x</b>\x02");
    act(() => {
      store.getState().setActiveWindow("c:#dev");
    });
    const bar = screen.getByTestId("title-bar");
    expect(bar.textContent).toContain("Séance — [#dev: <b>x</b>]");
    expect(bar.querySelector("b")).toBeNull();
  });

  it("uses the inactive style while the connect dialog is open", () => {
    setup(false);
    expect(screen.getByTestId("title-bar").dataset["active"]).toBe("false");
  });

  it("disables minimise and maximise", () => {
    setup(true);
    expect(screen.getByRole("button", { name: "Minimise" }).getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("button", { name: "Maximise" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("close quits only when connected", () => {
    const off = setup(false);
    const quit = vi.spyOn(off.store.getState(), "quit");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(off.socket.sent.some((l) => l.startsWith("QUIT"))).toBe(false);
    quit.mockRestore();
    cleanup();
    const on = setup(true);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(on.socket.sent.some((l) => l.startsWith("QUIT"))).toBe(true);
  });

  it("extracts the host and tolerates non-URLs", () => {
    expect(hostOf("wss://irc.example:6680/ws")).toBe("irc.example:6680");
    expect(hostOf("nonsense")).toBe("nonsense");
  });
});
