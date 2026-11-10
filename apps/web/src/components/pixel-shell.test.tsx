// Component tests for the Frame_01 shell (web-client-pixel-match tasks 5.10 and 6.6). jsdom does not
// lay out, so geometry is checked through the classes that set it (R1.8: sizes are classes only).
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClientStore } from "../store/client-store.js";
import { ClientStoreProvider } from "../store/react.js";
import type { SocketCloseInfo, WebSocketLike } from "../store/socket.js";
import { createClientStorage } from "../store/storage.js";
import { Shell } from "./ClientApp.js";
import { CreditsCounter } from "./CreditsCounter.js";
import { NickList } from "./NickList.js";
import { StatusBar } from "./StatusBar.js";
import { Switchbar } from "./Switchbar.js";
import { TitleBar } from "./TitleBar.js";
import { Toolbar } from "./Toolbar.js";

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

function connected() {
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
  const recv = (line: string): void => {
    act(() => {
      socket.onmessage?.({ data: `${line}\r\n` });
    });
  };
  recv(":srv 001 alice :Welcome");
  recv(":alice!a@h JOIN #dev");
  recv(":srv 353 alice = #dev :@alice +coder reviewer researcher");
  recv(":srv 366 alice #dev :End of /NAMES list");
  return { store, socket, recv };
}

type Store = ReturnType<typeof connected>["store"];

function mount(store: Store, node: ReactNode): void {
  render(<ClientStoreProvider store={store}>{node}</ClientStoreProvider>);
}

/** Injects a `matchMedia` whose Compact query matches or not. */
function setCompact(compact: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: compact && query.includes("max-width"),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

const realMatchMedia = window.matchMedia;
beforeEach(() => {
  setCompact(false);
});
afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
});

describe("Shell frame (5.1)", () => {
  it("draws the 3 px frame bevel and follows --app-height", () => {
    const { store } = connected();
    const { container } = render(
      <ClientStoreProvider store={store}>
        <Shell />
      </ClientStoreProvider>,
    );
    const frame = container.firstElementChild as HTMLElement;
    expect(frame.className).toContain("bevel-frame");
    expect(frame.className).toContain("p-(--layout-frame)");
    expect(frame.className).toContain("h-[var(--app-height,100dvh)]");
    expect(frame.querySelector("[style]")).toBeNull();
  });

  it("keeps the topic field in channel windows only (R2.5)", () => {
    const { store } = connected();
    mount(store, <Shell />);
    expect(screen.getByLabelText("Channel topic")).toBeTruthy();
    act(() => {
      store.getState().setActiveWindow("status");
    });
    expect(screen.queryByLabelText("Channel topic")).toBeNull();
  });

  it("adds the tray row only while a window is minimised (R1.4)", () => {
    const { store } = connected();
    mount(store, <Shell />);
    expect(screen.queryByRole("region", { name: "Minimised windows" })).toBeNull();
    act(() => {
      store.getState().minimiseWindow("c:#dev");
    });
    const tray = screen.getByRole("region", { name: "Minimised windows" });
    expect(tray.className).toContain("h-(--layout-tray)");
    const bar = within(tray).getByTestId("minimised-bar");
    expect(bar.className).toContain("w-44");
    expect(bar.className).toContain("h-6");
  });
});

describe("Title bar (5.4)", () => {
  it("shows the app candle and Minimise, Maximise, Close from the Figma buttons", () => {
    const { store } = connected();
    mount(store, <TitleBar />);
    const bar = screen.getByTestId("title-bar");
    expect(bar.querySelector("svg")?.getAttribute("data-icon")).toBe("app-candle");
    expect(within(bar).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Minimise",
      "Maximise",
      "Close",
    ]);
    expect(bar.className).toContain("h-[22px]");
  });
});

describe("Toolbar (5.5)", () => {
  it("orders the items connect | channels agents | logs | theme (no options button)", () => {
    const { store } = connected();
    mount(store, <Toolbar />);
    const toolbar = screen.getByRole("toolbar");
    const sequence = Array.from(toolbar.children).map((el) =>
      el.getAttribute("data-testid") === "toolbar-separator" ? "|" : el.getAttribute("data-toolbar-item"),
    );
    expect(sequence).toEqual(["connect", "|", "channels", "agents", "|", "logs", "|", "theme"]);
  });

  it("uses 26x24 buttons with the R4.2 offsets and 2x22 separators", () => {
    const { store } = connected();
    mount(store, <Toolbar />);
    const toolbar = screen.getByRole("toolbar");
    const offsets = within(toolbar)
      .getAllByRole("button")
      .map((b) => /\bml-(\S+)/.exec(b.className)?.[1]);
    expect(offsets).toEqual(["1", "[3px]", "px", "[3px]", "[3px]"]);
    for (const b of within(toolbar).getAllByRole("button")) {
      expect(b.className).toContain("w-[26px]");
      expect(b.className).toContain("h-6");
      expect(b.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    }
    for (const s of screen.getAllByTestId("toolbar-separator")) {
      expect(s.className).toContain("h-[22px]");
      expect(s.className).toContain("w-0.5");
      expect(s.className).toContain("ml-1");
    }
  });

  it("shows `Theme: Ghost` 33 px from the right, hidden in Compact (R4.4)", () => {
    const { store } = connected();
    mount(store, <Toolbar />);
    const label = screen.getByText("Theme: Ghost");
    expect(label.className).toContain("mr-[33px]");
    expect(label.className).toContain("hidden");
    expect(label.className).toContain("md:inline");
  });

  it("agents focuses the nick list on Desktop", () => {
    const { store } = connected();
    mount(
      store,
      <>
        <Toolbar />
        <NickList channel="#dev" members={store.getState().client.windows["c:#dev"]?.members} />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Agents" }));
    expect(document.activeElement?.id).toBe("nick-list");
    expect(store.getState().ui.nickOverlayOpen).toBe(false);
  });
});

describe("Nick list (5.9)", () => {
  it("uses the new ghosts, the away ghost for any away agent, and a dim prefix", () => {
    const { store, recv } = connected();
    recv(":srv 301 alice reviewer :lunch");
    const win = store.getState().client.windows["c:#dev"];
    mount(
      store,
      <NickList channel="#dev" members={win?.members} away={{ reviewer: "lunch" }} exorcised={win?.exorcised} />,
    );
    const list = screen.getByRole("list");
    const rows = within(list).getAllByRole("listitem");
    const icons = rows.map((r) => r.querySelector("svg")?.getAttribute("data-icon") ?? null);
    expect(icons).toEqual([null, "nick-agent-coder", "nick-agent-researcher", "nick-agent-researcher-away"]);
    for (const r of rows) expect(r.className).toContain("h-[22px]");
    const prefix = within(rows[0] as HTMLElement).getByText("@");
    expect(prefix.className).toContain("text-timestamp-dim");
  });

  it("is 181 px on Desktop, 140 px on Medium and hidden in Compact (R1.2, R11.3)", () => {
    const { store } = connected();
    const { container } = render(<NickList channel="#dev" members={store.getState().client.windows["c:#dev"]?.members} />);
    const aside = container.querySelector("aside") as HTMLElement;
    expect(aside.className).toContain("lg:w-(--layout-nick-desktop)");
    expect(aside.className).toContain("w-(--layout-nick-medium)");
    expect(aside.className).toContain("hidden");
    expect(aside.className).toContain("md:flex");
  });
});

describe("Switchbar and credits (5.8)", () => {
  it("draws the status, channel and query icons and marks unread in title-from", () => {
    const { store, recv } = connected();
    act(() => {
      store.getState().submitInput("/query bob");
    });
    act(() => {
      store.getState().setActiveWindow("status");
    });
    recv(":bob!b@h PRIVMSG #dev :hello");
    mount(store, <Switchbar />);
    const nav = screen.getByRole("navigation", { name: "Windows" });
    const buttons = within(nav).getAllByRole("button");
    expect(buttons.map((b) => b.querySelector("svg")?.getAttribute("data-icon"))).toEqual([
      "switch-status",
      "switch-channel",
      "switch-query",
    ]);
    const dev = buttons[1] as HTMLElement;
    expect(dev.className).toContain("text-title-from");
    expect(buttons[0]?.className).toContain("font-bold");
    for (const b of buttons) {
      expect(b.className).toContain("h-[22px]");
      expect(b.className).toContain("w-39");
    }
  });

  it("renders the credits panel with the candle slice, HTML text and a bold value", () => {
    const { store, recv } = connected();
    recv(":srv 320 alice coder :credits: #dev 1.25 / total 5.00");
    mount(store, <CreditsCounter />);
    const panel = screen.getByRole("status", { name: "Credits used by agents" });
    expect(panel.className).toContain("md:w-40");
    expect(panel.className).toContain("h-[22px]");
    expect(panel.querySelector("svg")?.getAttribute("data-icon")).toBe("credits-candle-slice");
    expect(panel.textContent).toMatch(/^credits: \d+\.\d$/);
    const value = panel.querySelector(".font-bold");
    expect(value?.textContent).toMatch(/^\d+\.\d$/);
    // Compact: the label is hidden, candle and value stay (R11.4).
    expect(within(panel).getByText("credits:", { exact: false }).className).toContain("hidden");
  });
});

describe("Status bar (5.8, 6.3)", () => {
  it("has four panels in the 562/140/258/461 ratio; lag and filler hide in Compact", () => {
    const { store } = connected();
    mount(store, <StatusBar />);
    const bar = screen.getAllByRole("status")[0] as HTMLElement;
    const panels = Array.from(bar.children) as HTMLElement[];
    expect(panels.map((p) => /grow-\[(\d+)\]/.exec(p.className)?.[1])).toEqual(["562", "140", "258", "461"]);
    expect(panels.map((p) => p.className.includes("hidden"))).toEqual([false, true, false, true]);
    expect(bar.className).toContain("gap-[3px]");
    expect(panels[0]?.className).toContain("truncate");
  });
});

describe("Compact nick overlay (6.2, 6.6)", () => {
  beforeEach(() => {
    setCompact(true);
  });

  it("hides the nick list and toggles the overlay from the toolbar, moving focus in and back", () => {
    const { store } = connected();
    mount(store, <Shell />);
    expect(screen.queryByRole("complementary", { name: "Members of #dev" })).toBeNull();
    expect(document.getElementById("nick-list")).toBeNull();
    const agents = screen.getByRole("button", { name: "Agents" });
    expect(agents.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(agents);
    const overlay = screen.getByRole("complementary", { name: "Members of #dev" });
    expect(overlay.className).toContain("w-[min(var(--layout-nick-overlay),80vw)]");
    expect(agents.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement?.id).toBe("nick-list");
    fireEvent.click(agents);
    expect(screen.queryByRole("complementary", { name: "Members of #dev" })).toBeNull();
    expect(document.activeElement).toBe(agents);
  });

  it("closes on Escape and on a tap outside", () => {
    const { store } = connected();
    mount(store, <Shell />);
    const agents = screen.getByRole("button", { name: "Agents" });
    fireEvent.click(agents);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(store.getState().ui.nickOverlayOpen).toBe(false);
    expect(document.activeElement).toBe(agents);
    fireEvent.click(agents);
    expect(store.getState().ui.nickOverlayOpen).toBe(true);
    fireEvent.pointerDown(screen.getByRole("log", { name: "#dev messages" }));
    expect(store.getState().ui.nickOverlayOpen).toBe(false);
  });

  it("closes when the active window changes", () => {
    const { store } = connected();
    mount(store, <Shell />);
    fireEvent.click(screen.getByRole("button", { name: "Agents" }));
    act(() => {
      store.getState().setActiveWindow("status");
    });
    expect(store.getState().ui.nickOverlayOpen).toBe(false);
  });
});
