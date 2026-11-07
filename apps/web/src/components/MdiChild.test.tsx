import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Window } from "../irc/index.js";
import { createClientStore } from "../store/client-store.js";
import { ClientStoreProvider } from "../store/react.js";
import type { SocketCloseInfo, WebSocketLike } from "../store/socket.js";
import { createClientStorage } from "../store/storage.js";
import { MdiChild, childTitleOf } from "./MdiChild.js";

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
  recv(":bob!b@h PRIVMSG alice :hi");
  const view = (key: string) => {
    const win = store.getState().client.windows[key] as Window;
    render(
      <ClientStoreProvider store={store}>
        <MdiChild window={win} label={`${win.name} window`} />
      </ClientStoreProvider>,
    );
  };
  return { store, recv, view };
}

const base: Window = { key: "c:#dev", kind: "channel", name: "#dev", lines: [], unread: false, mentioned: false };

describe("childTitleOf", () => {
  it("formats channel, status and query titles", () => {
    expect(childTitleOf({ ...base, modes: "+mnt", topic: "Fix it" }, "alice", "h")).toBe("#dev [+mnt]: Fix it");
    expect(childTitleOf(base, "alice", "h")).toBe("#dev");
    expect(childTitleOf({ ...base, modes: "+", topic: "\x02\x02" }, "alice", "h")).toBe("#dev");
    expect(childTitleOf({ ...base, key: "status", kind: "status", name: "Status" }, "alice", "irc.x")).toBe(
      "Status: alice on irc.x",
    );
    expect(childTitleOf({ ...base, kind: "query", name: "bob" }, "alice", "h")).toBe("bob");
  });
});

describe("MdiChild", () => {
  it("styles the active window with the active gradient and others inactive", () => {
    const { store, view } = setup();
    view("c:#dev");
    expect(screen.getByTestId("mdi-title").dataset["active"]).toBe("true");
    cleanup();
    store.getState().setActiveWindow("status");
    view("c:#dev");
    expect(screen.getByTestId("mdi-title").dataset["active"]).toBe("false");
  });

  it("disables Close on the Status window only", () => {
    const { view } = setup();
    view("status");
    expect((screen.getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    view("c:#dev");
    expect((screen.getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("Minimise minimises the window and Maximise keeps it active", () => {
    const { store, view } = setup();
    view("c:#dev");
    fireEvent.click(screen.getByRole("button", { name: "Maximise" }));
    expect(store.getState().ui.minimised).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Minimise" }));
    expect(store.getState().ui.minimised).toEqual(["c:#dev"]);
    expect(store.getState().client.activeKey).toBe("q:bob" in store.getState().client.windows ? "q:bob" : "status");
  });
});

describe("activating a minimised window", () => {
  it("setActiveWindow un-minimises it", () => {
    const { store } = setup();
    store.getState().minimiseWindow("q:bob");
    expect(store.getState().ui.minimised).toEqual(["q:bob"]);
    store.getState().setActiveWindow("q:bob");
    expect(store.getState().ui.minimised).toEqual([]);
    expect(store.getState().client.activeKey).toBe("q:bob");
  });
});
