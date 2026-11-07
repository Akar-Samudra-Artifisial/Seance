import { describe, expect, it } from "vitest";
import { createClientStore } from "./client-store.js";
import type { SocketCloseInfo, WebSocketLike } from "./socket.js";
import { createClientStorage } from "./storage.js";

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
  for (const ch of ["#a", "#b", "#c"]) recv(`:alice!a@h JOIN ${ch}`);
  return { store, recv };
}

describe("minimise and restore", () => {
  it("minimising the active window activates the next non-minimised one in order", () => {
    const { store } = setup();
    const s = store.getState();
    s.setActiveWindow("c:#a");
    s.minimiseWindow("c:#b");
    s.minimiseWindow("c:#a");
    expect(store.getState().ui.minimised).toEqual(["c:#b", "c:#a"]);
    expect(store.getState().client.activeKey).toBe("c:#c");
  });

  it("falls back to the Status_Window when nothing else is visible", () => {
    const { store } = setup();
    const s = store.getState();
    s.minimiseWindow("c:#a");
    s.minimiseWindow("c:#b");
    s.setActiveWindow("c:#c");
    s.minimiseWindow("status");
    s.minimiseWindow("c:#c");
    expect(store.getState().client.activeKey).toBe("status");
  });

  it("minimising a background window keeps the active one", () => {
    const { store } = setup();
    store.getState().setActiveWindow("c:#a");
    store.getState().minimiseWindow("c:#b");
    expect(store.getState().client.activeKey).toBe("c:#a");
  });

  it("restore un-minimises and activates", () => {
    const { store } = setup();
    store.getState().minimiseWindow("c:#b");
    store.getState().restoreWindow("c:#b");
    expect(store.getState().ui.minimised).toEqual([]);
    expect(store.getState().client.activeKey).toBe("c:#b");
  });

  it("does not affect routing, unread or mention flags", () => {
    const { store, recv } = setup();
    store.getState().setActiveWindow("c:#a");
    store.getState().minimiseWindow("c:#b");
    recv(":bob!b@h PRIVMSG #b :hi alice");
    const win = store.getState().client.windows["c:#b"];
    expect(win?.lines.some((l) => l.text.includes("hi alice"))).toBe(true);
    expect(win?.unread).toBe(true);
    expect(win?.mentioned).toBe(true);
  });

  it("prunes the key when the window closes and ignores unknown keys", () => {
    const { store, recv } = setup();
    store.getState().minimiseWindow("nope");
    expect(store.getState().ui.minimised).toEqual([]);
    store.getState().minimiseWindow("c:#b");
    recv(":alice!a@h PART #b");
    expect(store.getState().ui.minimised).toEqual([]);
  });

  it("survives reconnect", () => {
    const { store } = setup();
    store.getState().minimiseWindow("c:#b");
    store.getState().reconnect();
    expect(store.getState().ui.minimised).toEqual(["c:#b"]);
  });
});

describe("insertCommand", () => {
  it("fills the draft and clearDraft empties it", () => {
    const { store } = setup();
    store.getState().insertCommand("/join #");
    expect(store.getState().ui.draft).toBe("/join #");
    store.getState().clearDraft();
    expect(store.getState().ui.draft).toBeNull();
  });
});
