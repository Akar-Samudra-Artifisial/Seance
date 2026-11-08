import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { PASTE_INTERVAL_MS, PASTE_MAX_LINES } from "../irc/types.js";
import { INPUT_KEYS, MENU_DEFS, SHORTCUTS, mnemonicOf, windowSwitchIndex } from "../shortcuts/shortcuts.js";
import { createClientStore } from "../store/client-store.js";
import { ClientStoreProvider } from "../store/react.js";
import type { SocketCloseInfo, WebSocketLike } from "../store/socket.js";
import { createClientStorage } from "../store/storage.js";
import { ChannelListDialog } from "./ChannelListDialog.js";
import { InputLine } from "./InputLine.js";
import { MenuBar } from "./MenuBar.js";
import { MinimisedTray } from "./MinimisedTray.js";
import { ShortcutsDialog } from "./ShortcutsDialog.js";
import { TitleBar } from "./TitleBar.js";
import { Toolbar } from "./Toolbar.js";

afterEach(cleanup);

// web-client-extras: channel list dialog (R1), shortcuts (R4), explained disabled controls (R5).

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

type Stage = "fresh" | "status" | "channel" | "two-channels" | "dropped" | "connecting";

function makeStore(stage: Stage) {
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
  if (stage !== "fresh") {
    act(() => {
      store.getState().connect({ nick: "alice", serverUrl: ORIGIN, password: undefined });
    });
    if (stage !== "connecting") {
      act(() => {
        socket.onopen?.();
      });
      recv(":srv 001 alice :Welcome");
    }
  }
  if (stage === "channel" || stage === "two-channels") recv(":alice!a@h JOIN #dev");
  if (stage === "two-channels") recv(":alice!a@h JOIN #ops");
  if (stage === "dropped") {
    act(() => {
      socket.onclose?.({ code: 1006 } as SocketCloseInfo);
    });
  }
  return { store, socket, recv };
}

function renderWith(store: ReturnType<typeof makeStore>["store"], children: ReactNode): void {
  render(<ClientStoreProvider store={store}>{children}</ClientStoreProvider>);
}

describe("channel list dialog (R1)", () => {
  function open() {
    const env = makeStore("channel");
    renderWith(env.store, <ChannelListDialog />);
    act(() => {
      env.store.getState().openChannelList();
    });
    return env;
  }
  const rowNames = (): string[] =>
    screen.queryAllByRole("row").flatMap((r) => (r.getAttribute("data-channel") === null ? [] : [r.getAttribute("data-channel") ?? ""]));

  it("is closed by default and shows Loading… until 323", () => {
    const env = makeStore("channel");
    renderWith(env.store, <ChannelListDialog />);
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => {
      env.store.getState().openChannelList();
    });
    expect(screen.getByRole("dialog", { name: /Channels List/ })).toBeTruthy();
    expect(screen.getAllByText("Loading…").length).toBeGreaterThan(0);
  });

  it("lists rows after 323, strips control codes from topics and shows — for unknown agents", () => {
    const env = open();
    env.recv(":srv 322 alice #fix 3 :\x0304Fix\x03 NPE");
    env.recv(":srv 322 alice #dev 1 :joined one");
    env.recv(":srv 323 alice :End of /LIST");
    expect(rowNames()).toEqual(["#fix", "#dev"]);
    const fix = screen.getAllByRole("row").find((r) => r.getAttribute("data-channel") === "#fix");
    expect(fix?.textContent).toContain("Fix NPE");
    expect(fix?.textContent).not.toContain("\x03");
    expect(fix?.textContent).toContain("—");
    // #dev has a window, so its agent count is known (no Known_Agent member: 0).
    const dev = screen.getAllByRole("row").find((r) => r.getAttribute("data-channel") === "#dev");
    expect(dev?.textContent).not.toContain("—");
  });

  it("shows No channels for an empty list", () => {
    const env = open();
    env.recv(":srv 323 alice :End of /LIST");
    expect(screen.getByText("No channels")).toBeTruthy();
  });

  it("filters by text, min agents and empty topics on Apply filter only", () => {
    const env = open();
    env.recv(":srv 322 alice #fix 3 :Fix NPE");
    env.recv(":srv 322 alice #docs 1 :");
    env.recv(":srv 322 alice #far 2 :elsewhere");
    env.recv(":srv 323 alice :End of /LIST");
    fireEvent.change(screen.getByLabelText("Match text:"), { target: { value: "NPE" } });
    // Drafts do not filter until applied.
    expect(rowNames()).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Apply filter" }));
    expect(rowNames()).toEqual(["#fix"]);
    fireEvent.change(screen.getByLabelText("Match text:"), { target: { value: "" } });
    fireEvent.click(screen.getByLabelText("Hide channels without a topic"));
    fireEvent.submit(screen.getByLabelText("Match text:").closest("form") as HTMLFormElement);
    expect(rowNames()).toEqual(["#fix", "#far"]);
  });

  it("sorts by a column header with aria-sort, and cycles back to server order", () => {
    const env = open();
    env.recv(":srv 322 alice #b 2 :x");
    env.recv(":srv 322 alice #a 9 :y");
    env.recv(":srv 323 alice :End of /LIST");
    const users = screen.getByRole("columnheader", { name: /Users/ });
    const button = within(users).getByRole("button");
    fireEvent.click(button);
    expect(users.getAttribute("aria-sort")).toBe("ascending");
    expect(rowNames()).toEqual(["#b", "#a"]);
    fireEvent.click(button);
    expect(users.getAttribute("aria-sort")).toBe("descending");
    expect(rowNames()).toEqual(["#a", "#b"]);
    fireEvent.click(button);
    expect(users.getAttribute("aria-sort")).toBe("none");
    fireEvent.click(within(screen.getByRole("columnheader", { name: /Channel/ })).getByRole("button"));
    expect(rowNames()).toEqual(["#a", "#b"]);
  });

  it("joins on Enter and on double-click, and closes", () => {
    const env = open();
    env.recv(":srv 322 alice #far 2 :x");
    env.recv(":srv 323 alice :End of /LIST");
    const row = screen.getAllByRole("row").find((r) => r.getAttribute("data-channel") === "#far") as HTMLElement;
    act(() => row.focus());
    fireEvent.keyDown(row, { key: "Enter" });
    expect(env.socket.sent).toContain("JOIN #far\r\n");
    expect(env.store.getState().ui.channelListOpen).toBe(false);
  });

  it("double-click joins", () => {
    const env = open();
    env.recv(":srv 322 alice #far 2 :x");
    env.recv(":srv 323 alice :End of /LIST");
    fireEvent.doubleClick(screen.getAllByRole("row").find((r) => r.getAttribute("data-channel") === "#far") as HTMLElement);
    expect(env.socket.sent).toContain("JOIN #far\r\n");
  });

  it("Join is explained while nothing is selected", () => {
    const env = open();
    env.recv(":srv 323 alice :End of /LIST");
    const join = screen.getByRole("button", { name: "Join" });
    expect(join.getAttribute("aria-disabled")).toBe("true");
    expect(join.getAttribute("aria-description")).toBeTruthy();
    expect(join.getAttribute("title")).toBeTruthy();
  });

  it("Esc closes, Refresh asks again, the ? button toggles the hint", () => {
    const env = open();
    env.recv(":srv 323 alice :End of /LIST");
    const help = screen.getByRole("button", { name: "Help" });
    expect(screen.queryByText(/Enter or a double-click joins/)).toBeNull();
    fireEvent.click(help);
    expect(screen.getByText(/Enter or a double-click joins/)).toBeTruthy();
    expect(help.getAttribute("aria-expanded")).toBe("true");
    env.socket.sent.length = 0;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(env.socket.sent).toContain("LIST\r\n");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(env.store.getState().ui.channelListOpen).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("shortcuts (R4)", () => {
  it("the dialog has one row per registry entry and the paste note from the constants", () => {
    const env = makeStore("fresh");
    renderWith(env.store, <ShortcutsDialog />);
    act(() => {
      env.store.getState().openShortcuts();
    });
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    const rows = dialog.querySelectorAll("[data-shortcut]");
    expect(rows).toHaveLength(SHORTCUTS.length);
    expect(Array.from(rows).map((r) => r.getAttribute("data-shortcut"))).toEqual(
      expect.arrayContaining(SHORTCUTS.map((s) => s.id)),
    );
    const note = within(dialog).getByTestId("paste-note").textContent ?? "";
    expect(note).toContain(String(PASTE_MAX_LINES));
    expect(note).toContain(String(PASTE_INTERVAL_MS));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(env.store.getState().ui.shortcutsOpen).toBe(false);
  });

  it("the shortcut list is a focusable, named scroll region (review finding 4)", () => {
    const env = makeStore("fresh");
    renderWith(env.store, <ShortcutsDialog />);
    act(() => {
      env.store.getState().openShortcuts();
    });
    const region = screen.getByRole("region", { name: "Shortcut list" });
    expect(region.tabIndex).toBe(0);
    act(() => region.focus());
    expect(document.activeElement).toBe(region);
  });

  it("matches Alt+1..9 only, with the same rules the Shell uses", () => {
    const base = { altKey: true, ctrlKey: false, metaKey: false, key: "", code: "" };
    for (let n = 1; n <= 9; n += 1) {
      expect(windowSwitchIndex({ ...base, code: `Digit${String(n)}` })).toBe(n);
    }
    expect(windowSwitchIndex({ ...base, code: "Digit0" })).toBeNull();
    expect(windowSwitchIndex({ ...base, code: "Digit1", altKey: false })).toBeNull();
    expect(windowSwitchIndex({ ...base, code: "Digit1", ctrlKey: true })).toBeNull();
  });

  it("every menu button announces the mnemonic the registry lists", () => {
    const env = makeStore("fresh");
    renderWith(env.store, <MenuBar />);
    for (const def of MENU_DEFS) {
      const button = screen.getByRole("menuitem", { name: def.label });
      expect(button.getAttribute("aria-keyshortcuts")).toBe(`Alt+${mnemonicOf(def)}`);
      expect(SHORTCUTS.find((s) => s.id === `menu-${def.id}`)?.keys).toBe(`Alt+${mnemonicOf(def)}`);
    }
  });

  it("Alt+mnemonic opens the menu the registry names", () => {
    const env = makeStore("fresh");
    renderWith(env.store, <MenuBar />);
    fireEvent.keyDown(document, { altKey: true, code: "KeyH" });
    expect(screen.getByRole("menu", { name: "Help" })).toBeTruthy();
  });

  it("the Input_Line reacts to the registry keys: Tab completes, Up recalls", () => {
    const env = makeStore("channel");
    env.recv(":srv 353 alice = #dev :alice bobby");
    renderWith(env.store, <InputLine />);
    const input = screen.getByLabelText("Message or command") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "bo" } });
    input.setSelectionRange(2, 2);
    fireEvent.keyDown(input, { key: INPUT_KEYS.complete });
    expect(input.value.startsWith("bobby")).toBe(true);
    fireEvent.change(input, { target: { value: "hello" } });
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    fireEvent.keyDown(input, { key: INPUT_KEYS.historyUp });
    expect(input.value).toBe("hello");
  });

  it("Help → Keyboard shortcuts is enabled and opens the dialog", () => {
    const env = makeStore("fresh");
    renderWith(
      env.store,
      <>
        <MenuBar />
        <ShortcutsDialog />
      </>,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Help" }));
    const item = screen.getByRole("menuitem", { name: "Keyboard shortcuts" });
    expect(item.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(item);
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
  });
});

describe("explained disabled controls (R5)", () => {
  const stages: readonly Stage[] = ["fresh", "connecting", "status", "channel", "two-channels", "dropped"];

  /** Every disabled or inert control inside `root` must say why. */
  function unexplained(root: HTMLElement): string[] {
    const bad: string[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>("button, input, [role=menuitem], [role=menuitemcheckbox]"))) {
      const disabled = el.getAttribute("aria-disabled") === "true" || (el as HTMLButtonElement).disabled === true;
      if (!disabled) continue;
      const title = el.getAttribute("title") ?? "";
      const description = el.getAttribute("aria-description") ?? "";
      if (title.trim() === "" || description.trim() === "") {
        bad.push(`${el.getAttribute("aria-label") ?? el.textContent ?? el.tagName} (title="${title}", description="${description}")`);
      }
    }
    return bad;
  }

  it.each(stages)("toolbar, title bar, menu bar and every open menu in state %s", (stage) => {
    const env = makeStore(stage);
    renderWith(
      env.store,
      <>
        <TitleBar />
        <MenuBar />
        <Toolbar />
      </>,
    );
    expect(unexplained(document.body)).toEqual([]);
    for (const def of MENU_DEFS) {
      fireEvent.click(screen.getByRole("menuitem", { name: def.label }));
      const menu = screen.getByRole("menu", { name: def.label });
      expect(unexplained(menu)).toEqual([]);
      fireEvent.keyDown(menu, { key: "Escape" });
    }
  });

  it("gives the specific reasons the spec names", () => {
    const env = makeStore("two-channels");
    act(() => {
      env.store.getState().setActiveWindow(env.store.getState().client.order.at(-1) ?? "status");
    });
    renderWith(
      env.store,
      <>
        <TitleBar />
        <MenuBar />
        <Toolbar />
      </>,
    );
    expect(screen.getByRole("button", { name: "Options" }).getAttribute("aria-description")).toBe("Coming soon");
    expect(screen.getByRole("button", { name: "Connect" }).getAttribute("aria-description")).toBe("Disconnect first");
    expect(screen.getByRole("button", { name: "Minimise" }).getAttribute("aria-description")).toMatch(/browser tab/);
    fireEvent.click(screen.getByRole("menuitem", { name: "View" }));
    expect(screen.getByRole("menuitem", { name: "Next window" }).getAttribute("aria-description")).toBe(
      "Already the last window",
    );
    expect(screen.getByRole("button", { name: "Restore active window" }).getAttribute("aria-description")).toBeTruthy();
  });

  it("the minimised tray explains its disabled Status close button (review finding 1)", () => {
    const env = makeStore("channel");
    act(() => {
      env.store.getState().minimiseWindow("status");
    });
    renderWith(env.store, <MinimisedTray />);
    expect(unexplained(document.body)).toEqual([]);
    const close = screen.getByRole("button", { name: "Close" });
    expect(close).toHaveProperty("disabled", true);
    expect(close.getAttribute("aria-description")).toBe("The Status window cannot be closed");
  });

  it("an explained control stays inert when activated", () => {
    const env = makeStore("fresh");
    renderWith(env.store, <Toolbar />);
    fireEvent.click(screen.getByRole("button", { name: "Channel list" }));
    expect(env.store.getState().ui.channelListOpen).toBe(false);
  });
});
