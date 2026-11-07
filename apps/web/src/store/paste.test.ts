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
  privmsgs(): string[] {
    return this.sent.filter((l) => l.startsWith("PRIVMSG"));
  }
}

const ORIGIN = "ws://127.0.0.1:6680";

interface Timer {
  readonly id: number;
  readonly fn: () => void;
  readonly ms: number;
}

function setup() {
  const sockets: FakeSocket[] = [];
  let timers: Timer[] = [];
  let nextId = 1;
  const deps: StoreDeps = {
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    storage: createClientStorage(null, [ORIGIN]),
    now: () => 1000,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.push({ id, fn, ms });
      return id;
    },
    clearTimeout: (h) => {
      timers = timers.filter((t) => t.id !== h);
    },
    defaultServerUrl: ORIGIN,
    allowedOrigins: [ORIGIN],
  };
  const store = createClientStore(deps);
  store.getState().connect({ nick: "alice", serverUrl: ORIGIN, password: undefined });
  const sock = sockets[0];
  if (sock === undefined) throw new Error("no socket");
  sock.onopen?.();
  sock.recv(
    [":srv 001 alice :Welcome", ":alice!u@h JOIN #test", ":srv 366 alice #test :End of NAMES"]
      .map((l) => `${l}\r\n`)
      .join(""),
  );
  store.getState().setActiveWindow("c:#test");
  const fire = (): number => {
    const t = timers.shift();
    if (t === undefined) throw new Error("no pending timer");
    t.fn();
    return t.ms;
  };
  return { store, sock, fire, pending: () => timers.length };
}

const paste = (n: number): string => Array.from({ length: n }, (_, i) => `line${i + 1}`).join("\n");

describe("paste queue", () => {
  it("sends the first message at once and the rest every 500 ms", () => {
    const { store, sock, fire, pending } = setup();
    store.getState().submitInput(paste(3));
    expect(sock.privmsgs()).toEqual(["PRIVMSG #test line1\r\n"]);
    expect(store.getState().client.paste.queue).toHaveLength(2);
    expect(fire()).toBe(500);
    expect(sock.privmsgs()).toHaveLength(2);
    expect(fire()).toBe(500);
    expect(sock.privmsgs()).toEqual(["PRIVMSG #test line1\r\n", "PRIVMSG #test line2\r\n", "PRIVMSG #test line3\r\n"]);
    expect(pending()).toBe(0);
    expect(store.getState().client.paste.queue).toHaveLength(0);
    const texts = store.getState().client.windows["c:#test"]?.lines.map((l) => l.text) ?? [];
    expect(texts).toEqual(expect.arrayContaining(["line1", "line2", "line3"]));
  });

  it("asks for confirmation above 5 lines and sends nothing", () => {
    const { store, sock, pending } = setup();
    store.getState().submitInput(paste(7));
    expect(sock.privmsgs()).toHaveLength(0);
    expect(pending()).toBe(0);
    expect(store.getState().client.paste.pending?.lines).toHaveLength(7);
    const status = store.getState().client.windows["status"]?.lines.map((l) => l.text) ?? [];
    expect(status.some((t) => t.includes("7 lines"))).toBe(true);
  });

  it("confirm sends 5 lines and reports the dropped count", () => {
    const { store, sock, fire } = setup();
    store.getState().submitInput(paste(8));
    store.getState().confirmPaste(true);
    for (let i = 0; i < 4; i++) fire();
    expect(sock.privmsgs()).toHaveLength(5);
    expect(store.getState().client.paste.pending).toBeUndefined();
    const status = store.getState().client.windows["status"]?.lines.map((l) => l.text) ?? [];
    expect(status.some((t) => t.includes("3 lines dropped"))).toBe(true);
  });

  it("decline sends nothing and reports the unsent lines", () => {
    const { store, sock, pending } = setup();
    store.getState().submitInput(paste(6));
    store.getState().confirmPaste(false);
    expect(sock.privmsgs()).toHaveLength(0);
    expect(pending()).toBe(0);
    expect(store.getState().client.paste.pending).toBeUndefined();
    const status = store.getState().client.windows["status"]?.lines.map((l) => l.text) ?? [];
    expect(status.some((t) => t.includes("6 lines not sent"))).toBe(true);
  });

  it("empties the queue and reports the count when the socket closes", () => {
    const { store, sock, pending } = setup();
    store.getState().submitInput(paste(4));
    sock.onclose?.({ code: 1006, reason: "", wasClean: false });
    expect(store.getState().client.paste.queue).toHaveLength(0);
    expect(pending()).toBe(0);
    const status = store.getState().client.windows["status"]?.lines.map((l) => l.text) ?? [];
    expect(status.some((t) => t.includes("3 queued messages not sent"))).toBe(true);
    expect(sock.privmsgs()).toHaveLength(1);
  });
});
