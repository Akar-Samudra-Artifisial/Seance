import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Window } from "../irc/index.js";
import { createClientStore } from "../store/client-store.js";
import { ClientStoreProvider } from "../store/react.js";
import type { SocketCloseInfo, WebSocketLike } from "../store/socket.js";
import { createClientStorage } from "../store/storage.js";
import { ChildIcon, MdiChild, childTitleOf } from "./MdiChild.js";

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

// pixel-match R2.1: the Maximised_Child has no header of its own any more. The title moved to the
// application title bar and minimise/restore/close to the menu bar (covered in MenuBar.test.tsx),
// so the former header tests (mdi-title, child Close/Minimise/Maximise) are replaced by these.
describe("MdiChild", () => {
  it("is a labelled section with no title bar and no buttons", () => {
    const { view } = setup();
    view("c:#dev");
    const section = screen.getByRole("region", { name: "#dev window" });
    expect(section.tagName).toBe("SECTION");
    expect(screen.queryByTestId("mdi-title")).toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByRole("heading")).toBeNull();
  });

  it("renders its children inside the section", () => {
    const { store } = setup();
    const win = store.getState().client.windows["status"] as Window;
    render(
      <ClientStoreProvider store={store}>
        <MdiChild window={win} label="Status window">
          <p>content</p>
        </MdiChild>
      </ClientStoreProvider>,
    );
    const section = screen.getByRole("region", { name: "Status window" });
    expect(within(section).getByText("content")).toBeTruthy();
  });
});

describe("ChildIcon", () => {
  it.each([
    ["status", "tray-status"],
    ["channel", "mdi-child-channel"],
    ["query", "mdi-child-query"],
  ] as const)("%s uses %s", (kind, icon) => {
    const { container } = render(<ChildIcon kind={kind} />);
    expect(container.querySelector("svg")?.getAttribute("data-icon")).toBe(icon);
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
