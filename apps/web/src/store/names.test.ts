import { describe, expect, it } from "vitest";
import { createClientStore } from "./client-store.js";
import type { SocketCloseInfo, WebSocketLike } from "./socket.js";
import { createClientStorage } from "./storage.js";

const ORIGIN = "ws://127.0.0.1:6668";

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
  recv(":alice!a@h JOIN #Dev");
  recv(":srv 353 alice = #Dev :@alice bob");
  recv(":srv 366 alice #Dev :End of /NAMES list");
  return { store, socket, recv };
}

describe("/names expectingNames", () => {
  it("records the explicit channel, lower-cased, and prints one line on the reply", () => {
    const { store, socket, recv } = setup();
    store.getState().submitInput("/names #Dev");
    expect(socket.sent).toContain("NAMES #Dev\r\n");
    expect(store.getState().client.expectingNames).toEqual(["c:#dev"]);
    recv(":srv 353 alice = #Dev :@alice bob");
    recv(":srv 366 alice #Dev :End of /NAMES list");
    expect(store.getState().client.expectingNames).toEqual([]);
    expect(store.getState().client.windows["c:#dev"]?.lines.at(-1)?.text).toBe("Users on #Dev: @alice bob");
  });

  it("uses the active channel when no argument is given", () => {
    const { store } = setup();
    store.getState().submitInput("/names");
    expect(store.getState().client.expectingNames).toEqual(["c:#dev"]);
  });

  it("does not record anything for a non-NAMES message", () => {
    const { store } = setup();
    store.getState().submitInput("hello");
    expect(store.getState().client.expectingNames).toEqual([]);
  });
});
