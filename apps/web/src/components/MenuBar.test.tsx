import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { createClientStore } from "../store/client-store.js";
import { ClientStoreProvider } from "../store/react.js";
import type { SocketCloseInfo, WebSocketLike } from "../store/socket.js";
import { createClientStorage } from "../store/storage.js";
import { MenuBar } from "./MenuBar.js";

afterEach(cleanup);

const ORIGIN = "ws://127.0.0.1:6680";

class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { readonly data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: SocketCloseInfo) => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
}

function setup(register = true) {
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
  if (register) {
    store.getState().connect({ nick: "alice", serverUrl: ORIGIN, password: undefined });
    socket.onopen?.();
    const recv = (line: string): void => socket.onmessage?.({ data: `${line}\r\n` });
    recv(":srv 001 alice :Welcome");
    recv(":alice!a@h JOIN #dev");
    recv(":srv 366 alice #dev :End of /NAMES list");
  }
  render(
    <ClientStoreProvider store={store}>
      <MenuBar />
    </ClientStoreProvider>,
  );
  return { store, socket };
}

const bar = (name: string): HTMLElement => screen.getByRole("menuitem", { name });

describe("MenuBar", () => {
  it("shows the seven menus in order inside a menubar", () => {
    setup();
    const menubar = screen.getByRole("menubar");
    const names = within(menubar)
      .getAllByRole("menuitem")
      .map((b) => b.textContent);
    expect(names).toEqual(["File", "View", "Favorites", "Tools", "Commands", "Window", "Help"]);
  });

  it("uses a roving tabindex and ArrowLeft/ArrowRight/Home/End between menus", () => {
    setup();
    const file = bar("File");
    file.focus();
    expect(file.tabIndex).toBe(0);
    expect(bar("View").tabIndex).toBe(-1);
    fireEvent.keyDown(file, { key: "ArrowRight" });
    expect(document.activeElement).toBe(bar("View"));
    expect(bar("View").tabIndex).toBe(0);
    expect(file.tabIndex).toBe(-1);
    fireEvent.keyDown(bar("View"), { key: "End" });
    expect(document.activeElement).toBe(bar("Help"));
    fireEvent.keyDown(bar("Help"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(file);
    fireEvent.keyDown(file, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(bar("Help"));
    fireEvent.keyDown(bar("Help"), { key: "Home" });
    expect(document.activeElement).toBe(file);
  });

  it("opens with ArrowDown, walks items with arrows, Home and End, and closes on Escape", () => {
    setup();
    const file = bar("File");
    file.focus();
    fireEvent.keyDown(file, { key: "ArrowDown" });
    const menu = screen.getByRole("menu", { name: "File" });
    const items = within(menu).getAllByRole("menuitem");
    expect(file.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(file);
  });

  it("ArrowRight inside a menu opens the next menu", () => {
    setup();
    bar("File").focus();
    fireEvent.keyDown(bar("File"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("menu", { name: "File" }), { key: "ArrowRight" });
    expect(screen.getByRole("menu", { name: "View" })).toBeTruthy();
    expect(screen.queryByRole("menu", { name: "File" })).toBeNull();
  });

  it("opens a menu with Alt+mnemonic", () => {
    setup();
    fireEvent.keyDown(document, { key: "ı", code: "KeyC", altKey: true });
    expect(screen.getByRole("menu", { name: "Commands" })).toBeTruthy();
  });

  it("closes on an outside click", () => {
    setup();
    fireEvent.click(bar("File"));
    expect(screen.getByRole("menu", { name: "File" })).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("renders the mention sound item as a checkbox that toggles the store", () => {
    const { store } = setup();
    fireEvent.click(bar("View"));
    const box = screen.getByRole("menuitemcheckbox", { name: "Mention sound" });
    expect(box.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(box);
    expect(store.getState().ui.mentionSound).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("makes Connect… ask for the connect dialog while disconnected", () => {
    const { store } = setup(false);
    const before = store.getState().ui.connectRequests;
    fireEvent.click(bar("File"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Connect…" }));
    expect(store.getState().ui.connectRequests).toBe(before + 1);
  });

  describe("disabled items", () => {
    it("marks Favorites aria-disabled and never opens it", () => {
      setup();
      const fav = bar("Favorites");
      expect(fav.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(fav);
      fireEvent.keyDown(fav, { key: "ArrowDown" });
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("keeps unsupported items inert and the menu open", () => {
      const { socket } = setup();
      const sent = socket.sent.length;
      fireEvent.click(bar("Tools"));
      const options = screen.getByRole("menuitem", { name: "Options…" });
      expect(options.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(options);
      expect(screen.getByRole("menu", { name: "Tools" })).toBeTruthy();
      expect(socket.sent.length).toBe(sent);
    });

    it("disables connection-bound items until registered", () => {
      const { store } = setup(false);
      fireEvent.click(bar("Commands"));
      for (const name of ["Join…", "Part", "Query…", "Names", "Topic…", "Away…", "Back", "Quit"]) {
        expect(screen.getByRole("menuitem", { name }).getAttribute("aria-disabled")).toBe("true");
      }
      fireEvent.click(screen.getByRole("menuitem", { name: "Join…" }));
      expect(store.getState().ui.draft).toBeNull();
    });

    it("disables Part and Names in the Status_Window but not Join…", () => {
      const { store } = setup();
      act(() => {
        store.getState().setActiveWindow("status");
      });
      fireEvent.click(bar("Commands"));
      expect(screen.getByRole("menuitem", { name: "Part" }).getAttribute("aria-disabled")).toBe("true");
      expect(screen.getByRole("menuitem", { name: "Names" }).getAttribute("aria-disabled")).toBe("true");
      expect(screen.getByRole("menuitem", { name: "Join…" }).getAttribute("aria-disabled")).toBeNull();
    });
  });

  describe("Window menu", () => {
    it("lists every window with the active one checked and activates on click", () => {
      const { store } = setup();
      act(() => {
        store.getState().setActiveWindow("status");
      });
      fireEvent.click(bar("Window"));
      const menu = screen.getByRole("menu", { name: "Window" });
      const boxes = within(menu).getAllByRole("menuitemcheckbox");
      expect(boxes.map((b) => b.textContent?.replace("✓", ""))).toEqual(["Status", "#dev"]);
      expect(boxes.map((b) => b.getAttribute("aria-checked"))).toEqual(["true", "false"]);
      fireEvent.click(boxes[1] as HTMLElement);
      expect(store.getState().client.activeKey).toBe("c:#dev");
    });

    it("restores a minimised window when chosen", () => {
      const { store } = setup();
      act(() => {
        store.getState().minimiseWindow("c:#dev");
      });
      fireEvent.click(bar("Window"));
      fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "#dev" }));
      expect(store.getState().ui.minimised).toEqual([]);
      expect(store.getState().client.activeKey).toBe("c:#dev");
    });
  });

  describe("Input_Line prefill", () => {
    it.each([
      ["Commands", "Join…", "/join #"],
      ["Commands", "Query…", "/query "],
      ["Commands", "Topic…", "/topic "],
      ["Tools", "Whois…", "/whois "],
    ])("%s › %s puts %j into the draft", (menu, item, draft) => {
      const { store } = setup();
      fireEvent.click(bar(menu));
      fireEvent.click(screen.getByRole("menuitem", { name: item }));
      expect(store.getState().ui.draft).toBe(draft);
      expect(screen.queryByRole("menu")).toBeNull();
    });

    it("runs Names and Back directly", () => {
      const { socket } = setup();
      fireEvent.click(bar("Commands"));
      fireEvent.click(screen.getByRole("menuitem", { name: "Names" }));
      fireEvent.click(bar("Commands"));
      fireEvent.click(screen.getByRole("menuitem", { name: "Back" }));
      expect(socket.sent.some((l) => l.startsWith("NAMES"))).toBe(true);
      expect(socket.sent.some((l) => l.trim() === "AWAY")).toBe(true);
    });
  });

  describe("MDI child buttons", () => {
    it("minimise, restore and close act on the active window", () => {
      const { store } = setup();
      fireEvent.click(screen.getByRole("button", { name: "Minimise active window" }));
      expect(store.getState().ui.minimised).toEqual(["c:#dev"]);
      expect(store.getState().client.activeKey).toBe("status");
      fireEvent.click(screen.getByRole("button", { name: "Restore active window" }));
      store.getState().restoreWindow("c:#dev");
      expect(store.getState().ui.minimised).toEqual([]);
    });

    it("disables close for the Status_Window", () => {
      const { store } = setup();
      act(() => {
        store.getState().setActiveWindow("status");
      });
      const close = screen.getByRole("button", { name: "Close active window" });
      expect((close as HTMLButtonElement).disabled).toBe(true);
    });
  });
});
