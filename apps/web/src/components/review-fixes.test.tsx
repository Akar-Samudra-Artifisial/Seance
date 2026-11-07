// Regression tests for the web-client-polish review findings (plain labels, Reconnect, Alt keys, renders).
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Profiler } from "react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClientStore } from "../store/client-store.js";
import { ClientStoreProvider } from "../store/react.js";
import type { SocketCloseInfo, WebSocketLike } from "../store/socket.js";
import { createClientStorage } from "../store/storage.js";
import { MenuBar } from "./MenuBar.js";
import { MinimisedTray } from "./MinimisedTray.js";
import { NickList } from "./NickList.js";
import { StatusBar } from "./StatusBar.js";
import { TitleBar } from "./TitleBar.js";
import { Toolbar } from "./Toolbar.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

const ORIGIN = "ws://127.0.0.1:6680";
/** Right-to-left override and zero-width space: both must never reach a label. */
const EVIL = "#de\u202Ev\u200B";

class FakeSocket implements WebSocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((e: { readonly data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: SocketCloseInfo) => void) | null = null;
  send(): void {}
  close(): void {}
}

function setup(channel: string | null) {
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
  const recv = (line: string): void => {
    act(() => {
      socket.onmessage?.({ data: `${line}\r\n` });
    });
  };
  if (channel !== null) {
    act(() => {
      store.getState().connect({ nick: "alice", serverUrl: ORIGIN, password: undefined });
    });
    act(() => {
      socket.onopen?.();
    });
    recv(":srv 001 alice :Welcome");
    recv(`:alice!a@h JOIN ${channel}`);
  }
  return { store, socket, recv };
}

function wrap(store: ReturnType<typeof setup>["store"], ui: ReactNode) {
  return render(<ClientStoreProvider store={store}>{ui}</ClientStoreProvider>);
}

describe("window names are stripped of bidi and invisible characters", () => {
  it("MenuBar Window menu labels", () => {
    const { store } = setup(EVIL);
    wrap(store, <MenuBar />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Window" }));
    const menu = screen.getByRole("menu", { name: "Window" });
    expect(within(menu).getByRole("menuitemcheckbox", { name: "#dev" })).toBeTruthy();
    expect(menu.textContent).not.toMatch(/[\u202e\u200b]/);
  });

  it("MinimisedTray aria-label and title", () => {
    const { store } = setup(EVIL);
    act(() => {
      store.getState().minimiseWindow(`c:${EVIL.toLowerCase()}`);
    });
    wrap(store, <MinimisedTray />);
    const bar = screen.getByTestId("minimised-bar");
    const labelled = [bar, ...Array.from(bar.querySelectorAll("[aria-label],[title]"))];
    for (const el of labelled) {
      expect(`${el.getAttribute("aria-label") ?? ""}${el.getAttribute("title") ?? ""}`).not.toMatch(
        /[\u202e\u200b]/,
      );
    }
    expect(bar.getAttribute("aria-label")).toContain("#dev");
    expect(screen.getByRole("button", { name: /^Restore #dev/ })).toBeTruthy();
  });
});

describe("Reconnect is unavailable until a connection was made", () => {
  it("is disabled in the menu and shown as Connect in the toolbar, then enabled after a drop", () => {
    const { store, socket } = setup(null);
    wrap(store, <Toolbar />);
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
    cleanup();

    wrap(store, <MenuBar />);
    fireEvent.click(screen.getByRole("menuitem", { name: "File" }));
    expect(screen.getByRole("menuitem", { name: "Reconnect" }).getAttribute("aria-disabled")).toBe("true");
    cleanup();

    act(() => {
      store.getState().connect({ nick: "alice", serverUrl: ORIGIN, password: undefined });
    });
    act(() => {
      socket.onclose?.({ code: 1006, reason: "", wasClean: false });
    });
    wrap(store, <Toolbar />);
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
    cleanup();
    wrap(store, <MenuBar />);
    fireEvent.click(screen.getByRole("menuitem", { name: "File" }));
    expect(screen.getByRole("menuitem", { name: "Reconnect" }).getAttribute("aria-disabled")).toBeNull();
  });
});

describe("Alt+letter menu shortcuts", () => {
  const altF = { altKey: true, code: "KeyF", key: "ƒ" };

  it("leaves Option+letter to the Input_Line on macOS", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const { store } = setup("#dev");
    wrap(store, <MenuBar />);
    const input = document.createElement("input");
    input.id = "input-line";
    document.body.append(input);
    input.focus();
    expect(fireEvent.keyDown(input, altF)).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("still opens the menu outside the Input_Line on macOS", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const { store } = setup("#dev");
    wrap(store, <MenuBar />);
    expect(fireEvent.keyDown(document.body, altF)).toBe(false);
    expect(screen.getByRole("menu", { name: "File" })).toBeTruthy();
  });

  it("opens the menu from the Input_Line on other platforms", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    const { store } = setup("#dev");
    wrap(store, <MenuBar />);
    const input = document.createElement("input");
    input.id = "input-line";
    document.body.append(input);
    expect(fireEvent.keyDown(input, altF)).toBe(false);
    expect(screen.getByRole("menu", { name: "File" })).toBeTruthy();
  });
});

describe("narrow store subscriptions", () => {
  function renders(ui: ReactNode, store: ReturnType<typeof setup>["store"]) {
    let count = 0;
    wrap(
      store,
      <Profiler
        id="p"
        onRender={() => {
          count += 1;
        }}
      >
        {ui}
      </Profiler>,
    );
    return () => count;
  }

  it.each([
    ["StatusBar", <StatusBar key="s" />],
    ["TitleBar", <TitleBar key="t" />],
    ["MenuBar", <MenuBar key="m" />],
  ])("a new chat line does not re-render %s", (_name, ui) => {
    const { store, recv } = setup("#dev");
    const count = renders(ui, store);
    const before = count();
    recv(":bob!b@h PRIVMSG #dev :hello");
    recv(":bob!b@h PRIVMSG #dev :again");
    expect(count()).toBe(before);
  });
});

describe("NickList exorcised rows", () => {
  it("show a ghost glyph named exorcised and keep the dimmed agent colour", () => {
    render(<NickList channel="#dev" members={undefined} exorcised={["coder"]} />);
    const row = screen.getByRole("listitem");
    expect(within(row).getByRole("img", { name: "exorcised" })).toBeTruthy();
    expect(row.className).toContain("text-nick-coder");
    expect(row.className).toContain("line-through");
    expect(row.querySelector(".opacity-60")?.textContent).toBe("coder");
  });
});
