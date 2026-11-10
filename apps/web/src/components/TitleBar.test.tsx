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

  it("keeps minimise inert, and maximise inert where full screen is not available", () => {
    setup(true); // jsdom: document.fullscreenEnabled is undefined
    const min = screen.getByRole("button", { name: "Minimise" });
    expect(min.getAttribute("aria-disabled")).toBe("true");
    expect(min.getAttribute("aria-description")).toBe("Not available in a browser tab");
    const max = screen.getByRole("button", { name: "Maximise" });
    expect(max.getAttribute("aria-disabled")).toBe("true");
    expect(max.getAttribute("aria-description")).toBe("Not available in a browser tab");
  });

  describe("Maximise toggles browser full screen", () => {
    interface FullscreenDocument {
      fullscreenEnabled?: boolean;
      fullscreenElement?: Element | null;
      exitFullscreen?: () => Promise<void>;
    }
    const doc = document as unknown as FullscreenDocument;
    const root = document.documentElement as unknown as { requestFullscreen?: () => Promise<void> };

    const fullscreenState = (enabled: boolean | undefined, current: Element | null = null) => {
      Object.defineProperty(document, "fullscreenEnabled", { configurable: true, value: enabled });
      Object.defineProperty(document, "fullscreenElement", { configurable: true, value: current, writable: true });
    };
    const enterOrLeave = (current: Element | null): void => {
      act(() => {
        Object.defineProperty(document, "fullscreenElement", { configurable: true, value: current, writable: true });
        document.dispatchEvent(new Event("fullscreenchange"));
      });
    };

    afterEach(() => {
      delete doc.fullscreenEnabled;
      delete doc.fullscreenElement;
      delete doc.exitFullscreen;
      delete root.requestFullscreen;
    });

    it("calls requestFullscreen when not full screen and exitFullscreen when full screen", () => {
      fullscreenState(true);
      const request = vi.fn(() => Promise.resolve());
      const exit = vi.fn(() => Promise.resolve());
      root.requestFullscreen = request;
      doc.exitFullscreen = exit;
      setup(true);
      const enter = screen.getByRole("button", { name: "Full screen" });
      expect(enter.getAttribute("aria-disabled")).toBeNull();
      expect(enter.getAttribute("title")).toBe("Full screen");
      fireEvent.click(enter);
      expect(request).toHaveBeenCalledTimes(1);
      expect(exit).not.toHaveBeenCalled();

      enterOrLeave(document.documentElement);
      const leave = screen.getByRole("button", { name: "Exit full screen" });
      expect(leave.getAttribute("title")).toBe("Exit full screen");
      fireEvent.click(leave);
      expect(exit).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledTimes(1);
    });

    it("follows fullscreenchange, also when the user leaves with Esc", () => {
      fullscreenState(true);
      setup(true);
      expect(screen.getByRole("button", { name: "Full screen" })).toBeTruthy();
      enterOrLeave(document.documentElement);
      expect(screen.getByRole("button", { name: "Exit full screen" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Full screen" })).toBeNull();
      enterOrLeave(null); // Esc: the browser leaves full screen by itself
      expect(screen.getByRole("button", { name: "Full screen" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Exit full screen" })).toBeNull();
    });

    it("stays inert with its reason when fullscreenEnabled is false", () => {
      fullscreenState(false);
      const request = vi.fn(() => Promise.resolve());
      root.requestFullscreen = request;
      setup(true);
      const max = screen.getByRole("button", { name: "Maximise" });
      expect(max.getAttribute("aria-disabled")).toBe("true");
      expect(max.getAttribute("aria-description")).toBe("Not available in a browser tab");
      fireEvent.click(max);
      expect(request).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: "Full screen" })).toBeNull();
    });

    it("swallows a rejected requestFullscreen (no unhandled rejection, no console error)", async () => {
      fullscreenState(true);
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        root.requestFullscreen = vi.fn(() => Promise.reject(new TypeError("Permissions check failed")));
        setup(true);
        fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
        await new Promise<void>((resolve) => setImmediate(resolve));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(unhandled).not.toHaveBeenCalled();
        expect(consoleError).not.toHaveBeenCalled();
        // Nothing changed: still not full screen.
        expect(screen.getByRole("button", { name: "Full screen" })).toBeTruthy();
      } finally {
        process.off("unhandledRejection", unhandled);
        consoleError.mockRestore();
      }
    });

    it("swallows a requestFullscreen that throws synchronously", () => {
      fullscreenState(true);
      root.requestFullscreen = () => {
        throw new Error("not allowed");
      };
      setup(true);
      expect(() => {
        fireEvent.click(screen.getByRole("button", { name: "Full screen" }));
      }).not.toThrow();
    });
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
