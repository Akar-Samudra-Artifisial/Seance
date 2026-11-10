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
  // Favorites was removed (it had nothing behind it); six menus remain.
  it("shows the six menus in order inside a menubar, without Favorites", () => {
    setup();
    const menubar = screen.getByRole("menubar");
    const names = within(menubar)
      .getAllByRole("menuitem")
      .map((b) => b.textContent);
    expect(names).toEqual(["File", "View", "Tools", "Commands", "Window", "Help"]);
    expect(screen.queryByRole("menuitem", { name: "Favorites" })).toBeNull();
  });

  it("wraps ArrowLeft/ArrowRight around the six menus, and Alt+A (the old Favorites key) opens nothing", () => {
    setup();
    const file = bar("File");
    file.focus();
    fireEvent.keyDown(file, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(bar("Help"));
    fireEvent.keyDown(bar("Help"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(bar("File"));
    // Every remaining menu still opens with its own Alt key.
    for (const [code, name] of [
      ["KeyF", "File"],
      ["KeyV", "View"],
      ["KeyT", "Tools"],
      ["KeyC", "Commands"],
      ["KeyW", "Window"],
      ["KeyH", "Help"],
    ] as const) {
      fireEvent.keyDown(document, { key: code.slice(3).toLowerCase(), code, altKey: true });
      expect(screen.getByRole("menu", { name })).toBeTruthy();
      fireEvent.keyDown(screen.getByRole("menu", { name }), { key: "Escape" });
    }
    fireEvent.keyDown(document, { key: "a", code: "KeyA", altKey: true });
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("walks an open menu with ArrowRight through Tools, Commands, Window, Help and back to File", () => {
    setup();
    fireEvent.click(bar("View"));
    const order: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const open = screen.getAllByRole("menu")[0];
      if (open === undefined) throw new Error("no open menu");
      order.push(open.getAttribute("aria-label") ?? "");
      fireEvent.keyDown(open, { key: "ArrowRight" });
    }
    expect(order).toEqual(["View", "Tools", "Commands", "Window", "Help", "File"]);
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
    // Options… and Favorites had no task behind them and were removed; Tools holds Whois… only.
    it("has no Options… item: the Tools menu holds only Whois…", () => {
      setup();
      fireEvent.click(bar("Tools"));
      const menu = screen.getByRole("menu", { name: "Tools" });
      expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Whois…"]);
      expect(screen.queryByRole("menuitem", { name: "Options…" })).toBeNull();
      expect(screen.queryByText("Coming soon")).toBeNull();
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

  describe("Frame_01 geometry (R2.2, R5.2)", () => {
    it("puts the child icon first and gives the menus the fixed slot widths", () => {
      setup();
      const menubar = screen.getByRole("menubar");
      const row = menubar.parentElement as HTMLElement;
      expect(row.firstElementChild?.querySelector("svg")?.getAttribute("data-icon")).toBe("mdi-child-channel");
      const widths = within(menubar)
        .getAllByRole("menuitem")
        .map((b) => /w-\[(\d+)px\]/.exec(b.className)?.[1]);
      expect(widths).toEqual(["42", "42", "49", "69", "56", "56"]);
      for (const b of within(menubar).getAllByRole("menuitem")) {
        expect(b.className).toContain("text-left");
        expect(b.querySelector("u")).not.toBeNull();
      }
    });

    it("shows the Status monitor as child icon in the Status_Window", () => {
      const { store } = setup();
      act(() => {
        store.getState().setActiveWindow("status");
      });
      const row = screen.getByRole("menubar").parentElement as HTMLElement;
      expect(row.firstElementChild?.querySelector("svg")?.getAttribute("data-icon")).toBe("tray-status");
    });
  });

  describe("Compact overflow (R11.4, P6)", () => {
    const realRect = HTMLElement.prototype.getBoundingClientRect;
    afterEach(() => {
      HTMLElement.prototype.getBoundingClientRect = realRect;
    });
    const narrow = (width: number): void => {
      HTMLElement.prototype.getBoundingClientRect = function rect(this: HTMLElement): DOMRect {
        return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 20, width, height: 20, toJSON: () => ({}) };
      };
    };

    it("moves the menus that do not fit into the » list and opens them from there", () => {
      narrow(280); // with six menus, 280 px is what leaves File, View and Tools visible
      setup();
      const menubar = screen.getByRole("menubar");
      const names = within(menubar)
        .getAllByRole("menuitem")
        .map((b) => b.getAttribute("aria-label") ?? b.textContent);
      expect(names).toEqual(["File", "View", "Tools", "More menus"]);
      const more = screen.getByRole("menuitem", { name: "More menus" });
      fireEvent.click(more);
      const list = screen.getByRole("menu", { name: "More menus" });
      expect(within(list).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Commands", "Window", "Help"]);
      fireEvent.click(within(list).getByRole("menuitem", { name: "Commands" }));
      const commands = screen.getByRole("menu", { name: "Commands" });
      expect(within(commands).getByRole("menuitem", { name: "Join…" })).toBeTruthy();
      fireEvent.keyDown(commands, { key: "Escape" });
      expect(screen.queryByRole("menu")).toBeNull();
      expect(document.activeElement).toBe(more);
    });

    it("keeps keyboard order: ArrowRight from the last visible menu lands on »; Alt+mnemonic still opens hidden menus", () => {
      narrow(280);
      setup();
      const tools = bar("Tools");
      tools.focus();
      fireEvent.keyDown(tools, { key: "ArrowRight" });
      const more = screen.getByRole("menuitem", { name: "More menus" });
      expect(document.activeElement).toBe(more);
      expect(more.tabIndex).toBe(0);
      fireEvent.keyDown(document, { key: "w", code: "KeyW", altKey: true });
      expect(screen.getByRole("menu", { name: "Window" })).toBeTruthy();
    });

    it("shows every menu and no » when the bar is wide", () => {
      narrow(1434);
      setup();
      expect(screen.queryByRole("menuitem", { name: "More menus" })).toBeNull();
      expect(within(screen.getByRole("menubar")).getAllByRole("menuitem")).toHaveLength(6);
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

    it("makes restore aria-disabled with its title unless the active window is minimised (R2.3)", () => {
      const { store } = setup();
      const restore = screen.getByRole("button", { name: "Restore active window" });
      expect(restore.getAttribute("aria-disabled")).toBe("true");
      expect(restore.getAttribute("title")).toBe("Restore (this client keeps one maximised window)");
      fireEvent.click(restore);
      expect(store.getState().ui.minimised).toEqual([]);
    });

    it("draws the child buttons with the Figma icons and swaps to the pressed drawing", () => {
      setup();
      const group = screen.getByRole("group", { name: "Active window controls" });
      const icons = Array.from(group.querySelectorAll("svg")).map((s) => s.getAttribute("data-icon"));
      // Live buttons carry raised + pressed drawings; the inert restore keeps only the raised one.
      expect(icons).toEqual(["btn-min", "btn-min-pressed", "btn-restore", "btn-close", "btn-close-pressed"]);
      for (const svg of Array.from(group.querySelectorAll("svg"))) {
        expect(svg.getAttribute("aria-hidden")).toBe("true");
      }
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
