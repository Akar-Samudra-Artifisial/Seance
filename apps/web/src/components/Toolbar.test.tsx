import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createClientStore } from "../store/client-store.js";
import { ClientStoreProvider } from "../store/react.js";
import type { SocketCloseInfo, WebSocketLike } from "../store/socket.js";
import { createClientStorage } from "../store/storage.js";
import { Toolbar } from "./Toolbar.js";

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

function setup(registered: boolean) {
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
  if (registered) {
    store.getState().connect({ nick: "alice", serverUrl: ORIGIN, password: undefined });
    socket.onopen?.();
    socket.onmessage?.({ data: ":srv 001 alice :Welcome\r\n" });
    socket.onmessage?.({ data: ":alice!a@h JOIN #dev\r\n" });
  }
  render(
    <ClientStoreProvider store={store}>
      <Toolbar />
    </ClientStoreProvider>,
  );
  return store;
}

describe("Toolbar", () => {
  it("is a labelled toolbar with named, titled buttons and the theme label", () => {
    setup(false);
    expect(screen.getByRole("toolbar", { name: "Toolbar" })).toBeTruthy();
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(6);
    for (const b of buttons) {
      expect(b.getAttribute("aria-label")).toBeTruthy();
      // web-client-extras R5: a disabled button explains itself in the tooltip ("<label>: <reason>").
      const label = b.getAttribute("aria-label") ?? "";
      if (b.getAttribute("aria-disabled") === "true") {
        expect(b.getAttribute("title")).toMatch(new RegExp(`^${label}: .+`));
        expect(b.getAttribute("aria-description")).toBeTruthy();
      } else {
        expect(b.getAttribute("title")).toBe(label);
      }
      expect(b.getAttribute("style")).toBeNull();
      expect(b.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    }
    expect(screen.getByText("Theme: Ghost")).toBeTruthy();
  });

  // web-client-extras: Toggle theme now works (R3), so it left this list; Agents joined it outside a channel.
  it("disables options, channel list and agents with aria-disabled and ignores clicks", () => {
    const store = setup(false);
    for (const name of ["Options", "Channel list", "Agents"]) {
      const b = screen.getByRole("button", { name });
      expect(b.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(b);
    }
    expect(store.getState().ui.connectRequests).toBe(0);
  });

  it("keeps Options disabled even when connected, and enables the channel list", () => {
    setup(true);
    expect(screen.getByRole("button", { name: "Options" }).getAttribute("aria-description")).toBe("Coming soon");
    expect(screen.getByRole("button", { name: "Channel list" }).getAttribute("aria-disabled")).toBeNull();
  });

  it("toggle theme switches the theme and the label", () => {
    const store = setup(false);
    fireEvent.click(screen.getByRole("button", { name: "Toggle theme" }));
    expect(store.getState().ui.theme).toBe("classic");
    expect(screen.getByText("Classic", { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Toggle theme" }));
    expect(store.getState().ui.theme).toBe("ghost");
  });

  it("connect requests the Connect_Dialog", () => {
    const store = setup(false);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(store.getState().ui.connectRequests).toBe(1);
  });

  it("logs shows the Status_Window", () => {
    const store = setup(true);
    store.getState().setActiveWindow("#dev");
    fireEvent.click(screen.getByRole("button", { name: "Status window" }));
    expect(store.getState().client.activeKey).toBe("status");
  });

  it("agents focuses the Nick_List", () => {
    setup(true); // in a channel window
    const list = document.createElement("ul");
    list.id = "nick-list";
    list.tabIndex = 0;
    document.body.append(list);
    fireEvent.click(screen.getByRole("button", { name: "Agents" }));
    expect(document.activeElement).toBe(list);
    list.remove();
  });

  it("moves focus with arrow keys, wrapping, with roving tabindex", () => {
    setup(false);
    const buttons = screen.getAllByRole("button");
    const toolbar = screen.getByRole("toolbar");
    buttons[0]?.focus();
    fireEvent.keyDown(toolbar, { key: "ArrowRight" });
    expect(document.activeElement).toBe(buttons[1]);
    expect(buttons[1]?.getAttribute("tabindex")).toBe("0");
    expect(buttons[0]?.getAttribute("tabindex")).toBe("-1");
    fireEvent.keyDown(toolbar, { key: "End" });
    expect(document.activeElement).toBe(buttons[5]);
    fireEvent.keyDown(toolbar, { key: "ArrowRight" });
    expect(document.activeElement).toBe(buttons[0]);
    fireEvent.keyDown(toolbar, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(buttons[5]);
  });
});
