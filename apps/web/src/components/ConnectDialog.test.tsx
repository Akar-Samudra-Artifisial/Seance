import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createClientStore } from "../store/client-store.js";
import type { StoreDeps } from "../store/client-store.js";
import { ClientStoreProvider } from "../store/react.js";
import type { SocketCloseInfo, WebSocketLike } from "../store/socket.js";
import { NICK_KEY, SERVER_URL_KEY, createClientStorage } from "../store/storage.js";
import { ConnectDialog } from "./ConnectDialog.js";

afterEach(cleanup);

const ALLOWED = "ws://127.0.0.1:6680";

class FakeSocket implements WebSocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((e: { readonly data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: SocketCloseInfo) => void) | null = null;
  closes = 0;
  send(): void {}
  close(): void {
    this.closes += 1;
  }
}

function setup(stored: Record<string, string> = {}) {
  const sockets: FakeSocket[] = [];
  const backend = {
    getItem: (k: string): string | null => stored[k] ?? null,
    setItem: (): void => {},
  };
  const deps: StoreDeps = {
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    storage: createClientStorage(backend, [ALLOWED]),
    now: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    defaultServerUrl: ALLOWED,
    allowedOrigins: [ALLOWED],
  };
  const store = createClientStore(deps);
  render(
    <ClientStoreProvider store={store}>
      <input id="input-line" aria-label="Message or command" />
      <ConnectDialog />
    </ClientStoreProvider>,
  );
  return { store, sockets };
}

describe("ConnectDialog", () => {
  it("Cancel while connecting closes the pending socket", () => {
    const { store, sockets } = setup();
    fireEvent.change(screen.getByLabelText("Nick"), { target: { value: "alice" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(store.getState().client.phase).toBe("connecting");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(sockets[0]?.closes).toBe(1);
    expect(store.getState().client.phase).toBe("disconnected");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("is a labelled modal dialog", () => {
    setup();
    const dialog = screen.getByRole("dialog", { name: "Connect to Séance" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(screen.getByLabelText("Nick")).toBeTruthy();
    expect(screen.getByLabelText("Server URL")).toBeTruthy();
  });

  it("refuses a disallowed origin, names the allowed ones and links the error", () => {
    const { sockets } = setup();
    fireEvent.change(screen.getByLabelText("Nick"), { target: { value: "alice" } });
    fireEvent.change(screen.getByLabelText("Server URL"), { target: { value: "ws://evil.example:1" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(sockets).toHaveLength(0);
    const input = screen.getByLabelText("Server URL");
    const errorId = input.getAttribute("aria-describedby");
    expect(errorId).toBeTruthy();
    const error = document.getElementById(errorId ?? "");
    expect(error?.textContent).toContain(ALLOWED);
  });

  it("links an invalid nick error with aria-describedby", () => {
    setup();
    fireEvent.change(screen.getByLabelText("Nick"), { target: { value: "1bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    const errorId = screen.getByLabelText("Nick").getAttribute("aria-describedby");
    expect(document.getElementById(errorId ?? "")?.textContent).toContain("not a valid nick");
  });

  it("ignores a stored disallowed origin", () => {
    setup({ [NICK_KEY]: "alice", [SERVER_URL_KEY]: "ws://evil.example:1" });
    expect((screen.getByLabelText("Server URL") as HTMLInputElement).value).toBe(ALLOWED);
    expect((screen.getByLabelText("Nick") as HTMLInputElement).value).toBe("alice");
  });

  it("explains the password field under it and keeps its label", () => {
    setup();
    expect(screen.getByText("Account secret, or the server password")).toBeTruthy();
    const input = screen.getByLabelText("Password (optional)");
    expect(input.getAttribute("id")).toBe("connect-password");
    expect(input.getAttribute("type")).toBe("password");
    const help = document.getElementById("connect-password-help");
    expect(help?.textContent).toBe("Account secret, or the server password");
    expect(input.getAttribute("aria-describedby")).toContain("connect-password-help");
  });

  it("focuses the nick field when empty", () => {
    setup();
    expect(document.activeElement).toBe(screen.getByLabelText("Nick"));
  });

  it("focuses the password field when nick and URL are prefilled", () => {
    setup({ [NICK_KEY]: "alice", [SERVER_URL_KEY]: ALLOWED });
    expect(document.activeElement).toBe(screen.getByLabelText("Password (optional)"));
  });

  it("closes on Esc and returns focus to the input line", () => {
    setup();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(document.getElementById("input-line"));
  });

  // Changed with the shared window chrome: the caption `Close` button is now the first stop of the
  // cycle, as in every other dialog, so Tab from the last button lands there, not on Nick.
  it("cycles Tab inside the dialog, through the caption Close button", () => {
    setup();
    const connectButton = screen.getByRole("button", { name: "Connect" });
    const closeButton = screen.getByRole("button", { name: "Close" });
    connectButton.focus();
    fireEvent.keyDown(connectButton, { key: "Tab" });
    expect(document.activeElement).toBe(closeButton);
    fireEvent.keyDown(closeButton, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(connectButton);
  });

  it("uses the shared window chrome: a full-width caption bar with a Close button", () => {
    setup();
    const dialog = screen.getByRole("dialog", { name: "Connect to Séance" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe("connect-title");
    const title = document.getElementById("connect-title");
    expect(title?.tagName).toBe("H2");
    expect(title?.textContent).toBe("Connect to Séance");
    // The caption bar is a direct child of the window frame, not inside the padded form.
    const caption = title?.parentElement;
    expect(caption?.parentElement).toBe(dialog);
    expect(caption?.className).toContain("from-title-from");
    const close = screen.getByRole("button", { name: "Close" });
    expect(close.parentElement).toBe(caption);
    expect(close.getAttribute("title")).toBe("Close (Esc)");
    expect(dialog.className).toContain("bevel-frame");
    expect(dialog.className).toContain("w-96");
    expect(dialog.className).toContain("max-w-full");
    // The form sits in a padded body under the caption; the overlay keeps its stacking.
    expect(dialog.querySelector("form")?.className).toContain("p-2");
    expect(dialog.parentElement?.className).toContain("z-10");
  });

  it("the caption Close button does what Cancel does", () => {
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(document.getElementById("input-line"));
    cleanup();

    const cancelled = setup();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(document.getElementById("input-line"));
    // A request from the toolbar or menu reopens it, after Close as after Cancel.
    act(() => {
      cancelled.store.getState().requestConnectDialog();
    });
    expect(screen.getByRole("dialog", { name: "Connect to Séance" })).toBeTruthy();
  });

  it("Esc closes the dialog once and it can be reopened", () => {
    const { store } = setup();
    fireEvent.keyDown(screen.getByLabelText("Nick"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(document.getElementById("input-line"));
    act(() => {
      store.getState().requestConnectDialog();
    });
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows Reconnect and a connection closed line after a registered socket closes", () => {
    const { store, sockets } = setup({ [NICK_KEY]: "alice", [SERVER_URL_KEY]: ALLOWED });
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
    act(() => {
      store.getState().connect({ nick: "alice", serverUrl: ALLOWED, password: undefined });
    });
    const sock = sockets[0];
    if (sock === undefined) throw new Error("no socket");
    act(() => {
      sock.onopen?.();
      sock.onmessage?.({ data: ":srv 001 alice :Welcome\r\n" });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => {
      sock.onclose?.({ code: 1006, reason: "", wasClean: false });
    });
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
    const lines = store.getState().client.windows["status"]?.lines ?? [];
    expect(lines.some((l) => l.text.includes("connection closed"))).toBe(true);
  });
});
