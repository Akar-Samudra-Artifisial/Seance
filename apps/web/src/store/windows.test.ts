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
  recv(":alice!a@h JOIN #dev");
  recv(":srv 366 alice #dev :End of /NAMES list");
  return { store, socket, recv };
}

describe("window actions", () => {
  it("/query <nick> opens and activates a query window", () => {
    const { store } = setup();
    store.getState().submitInput("/query bob");
    const c = store.getState().client;
    expect(c.activeKey).toBe("q:bob");
    expect(c.windows["q:bob"]?.kind).toBe("query");
    expect(c.order).toEqual(["status", "c:#dev", "q:bob"]);
  });

  it("/msg <nick> text opens, activates and echoes into the query window", () => {
    const { store, socket } = setup();
    store.getState().submitInput("/msg Bob hello");
    const c = store.getState().client;
    expect(c.activeKey).toBe("q:bob");
    expect(c.windows["q:bob"]?.lines.map((l) => l.text)).toContain("hello");
    expect(socket.sent.some((l) => l.startsWith("PRIVMSG Bob"))).toBe(true);
  });

  it("closeWindow removes a query window and falls back to status", () => {
    const { store } = setup();
    store.getState().submitInput("/query bob");
    store.getState().closeWindow("q:bob");
    const c = store.getState().client;
    expect(c.windows["q:bob"]).toBeUndefined();
    expect(c.order).toEqual(["status", "c:#dev"]);
    expect(c.activeKey).toBe("status");
  });

  it("closeWindow on a channel sends PART and the echo closes the window", () => {
    const { store, socket, recv } = setup();
    store.getState().closeWindow("c:#dev");
    expect(socket.sent).toContain("PART #dev\r\n");
    expect(store.getState().client.windows["c:#dev"]).toBeDefined();
    recv(":alice!a@h PART #dev");
    expect(store.getState().client.windows["c:#dev"]).toBeUndefined();
  });

  it("closeWindow ignores the status window", () => {
    const { store } = setup();
    store.getState().closeWindow("status");
    expect(store.getState().client.windows["status"]).toBeDefined();
  });

  it("activateByIndex picks the nth window and clears its unread marker", () => {
    const { store, recv } = setup();
    store.getState().setActiveWindow("status");
    recv(":bob!b@h PRIVMSG #dev :hi there");
    expect(store.getState().client.windows["c:#dev"]?.unread).toBe(true);
    store.getState().activateByIndex(2);
    const c = store.getState().client;
    expect(c.activeKey).toBe("c:#dev");
    expect(c.windows["c:#dev"]?.unread).toBe(false);
    store.getState().activateByIndex(9);
    expect(store.getState().client.activeKey).toBe("c:#dev");
    store.getState().activateByIndex(1);
    expect(store.getState().client.activeKey).toBe("status");
  });
});
