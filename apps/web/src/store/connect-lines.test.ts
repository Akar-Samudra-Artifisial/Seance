import { describe, expect, it } from "vitest";
import { createClientStore } from "./client-store.js";
import type { StoreDeps } from "./client-store.js";
import type { SocketCloseInfo, WebSocketLike } from "./socket.js";
import { createClientStorage } from "./storage.js";

class FakeSocket implements WebSocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((e: { readonly data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: SocketCloseInfo) => void) | null = null;
  send(): void {}
  close(): void {}
}

function setup(url: string) {
  const sockets: FakeSocket[] = [];
  const deps: StoreDeps = {
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    storage: createClientStorage(null, [url]),
    now: () => 1000,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    defaultServerUrl: url,
    allowedOrigins: [url],
  };
  const store = createClientStore(deps);
  store.getState().connect({ nick: "alice", serverUrl: url, password: undefined });
  const lines = () => store.getState().client.windows["status"]?.lines ?? [];
  return { sockets, lines };
}

describe("Status window connection lines", () => {
  it("writes the plain progress lines for ws", () => {
    const t = setup("ws://127.0.0.1:6680");
    expect(t.lines().find((l) => l.text.startsWith("* Connecting"))).toMatchObject({
      kind: "local",
      text: "* Connecting to 127.0.0.1 (6680)",
    });
    t.sockets[0]?.onopen?.();
    expect(t.lines().at(-1)).toMatchObject({ kind: "join", text: "Connected to 127.0.0.1" });
  });

  it("marks TLS for wss", () => {
    const t = setup("wss://irc.example.org:6697");
    expect(t.lines().some((l) => l.text === "* Connecting to irc.example.org (6697)")).toBe(true);
    t.sockets[0]?.onopen?.();
    expect(t.lines().at(-1)?.text).toBe("Connected to irc.example.org (TLS)");
  });
});
