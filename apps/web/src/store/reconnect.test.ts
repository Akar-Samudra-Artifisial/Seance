import { describe, expect, it } from "vitest";
import { createClientStore } from "./client-store.js";
import type { StoreDeps } from "./client-store.js";
import type { SocketCloseInfo, WebSocketLike } from "./socket.js";
import { createClientStorage } from "./storage.js";

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
  recv(data: string): void {
    this.onmessage?.({ data });
  }
}

const ORIGIN = "ws://127.0.0.1:6680";

describe("store reconnect", () => {
  it("keeps Chat_Buffers, clears members and topics, and enters connecting", () => {
    const sockets: FakeSocket[] = [];
    const deps: StoreDeps = {
      createSocket: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      storage: createClientStorage(null, [ORIGIN]),
      now: () => 1000,
      setTimeout: () => 0,
      clearTimeout: () => undefined,
      defaultServerUrl: ORIGIN,
      allowedOrigins: [ORIGIN],
    };
    const store = createClientStore(deps);
    store.getState().connect({ nick: "alice", serverUrl: ORIGIN, password: undefined });
    const first = sockets[0];
    if (first === undefined) throw new Error("no socket");
    first.onopen?.();
    first.recv(
      [
        ":srv 001 alice :Welcome",
        ":alice!u@h JOIN #test",
        ":srv 332 alice #test :a topic",
        ":srv 353 alice = #test :@bob alice",
        ":srv 366 alice #test :End of NAMES",
        ":bob!u@h PRIVMSG #test :hello",
      ]
        .map((l) => `${l}\r\n`)
        .join(""),
    );
    const linesBefore = store.getState().client.windows["c:#test"]?.lines;
    expect(linesBefore?.some((l) => l.text === "hello")).toBe(true);
    first.onclose?.({ code: 1006, reason: "", wasClean: false });

    store.getState().reconnect();

    const client = store.getState().client;
    expect(sockets).toHaveLength(2);
    expect(client.phase).toBe("connecting");
    expect(client.windows["c:#test"]?.lines).toEqual(linesBefore);
    expect(client.windows["c:#test"]?.members).toEqual({});
    expect(client.windows["c:#test"]?.topic).toBeUndefined();
  });
});
