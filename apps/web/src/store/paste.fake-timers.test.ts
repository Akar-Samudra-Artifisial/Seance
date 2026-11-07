import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClientStore } from "./client-store.js";
import type { StoreDeps } from "./client-store.js";
import type { SocketCloseInfo, WebSocketLike } from "./socket.js";
import { createClientStorage } from "./storage.js";

// Paste_Queue tests driven by vi.useFakeTimers(): StoreDeps timers are wired to
// the (faked) global timers, so no real timer or wall-clock sleep is involved.

const TIMEOUT_MS = 5_000;
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
  recv(data: string): void {
    this.onmessage?.({ data });
  }
  privmsgs(): string[] {
    return this.sent.filter((l) => l.startsWith("PRIVMSG"));
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const deps: StoreDeps = {
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    storage: createClientStorage(null, [ORIGIN]),
    now: () => Date.now(),
    // The 30 s lag timer is not under test here; keep it out of the paste timer count.
    setTimeout: (fn, ms) => (ms === 30_000 ? -1 : globalThis.setTimeout(fn, ms)),
    clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
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
  const status = (): string[] => store.getState().client.windows["status"]?.lines.map((l) => l.text) ?? [];
  return { store, sock, status };
}

const paste = (n: number): string => Array.from({ length: n }, (_, i) => `line${i + 1}`).join("\n");

describe("paste queue (fake timers)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("sends the first message immediately without advancing time", { timeout: TIMEOUT_MS }, () => {
    const { store, sock } = setup();
    store.getState().submitInput(paste(3));
    expect(sock.privmsgs()).toEqual(["PRIVMSG #test line1\r\n"]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("paces the remaining messages every 500 ms", { timeout: TIMEOUT_MS }, () => {
    const { store, sock } = setup();
    store.getState().submitInput(paste(3));
    vi.advanceTimersByTime(499);
    expect(sock.privmsgs()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sock.privmsgs()).toHaveLength(2);
    vi.advanceTimersByTime(499);
    expect(sock.privmsgs()).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sock.privmsgs()).toEqual(["PRIVMSG #test line1\r\n", "PRIVMSG #test line2\r\n", "PRIVMSG #test line3\r\n"]);
    expect(store.getState().client.paste.queue).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("requires confirmation above 5 lines and sends nothing meanwhile", { timeout: TIMEOUT_MS }, () => {
    const { store, sock, status } = setup();
    store.getState().submitInput(paste(7));
    vi.advanceTimersByTime(500);
    expect(sock.privmsgs()).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(store.getState().client.paste.pending?.lines).toHaveLength(7);
    expect(status().some((t) => t.includes("7 lines"))).toBe(true);
  });

  it("confirm sends 5 lines paced by 500 ms and reports the dropped count", { timeout: TIMEOUT_MS }, () => {
    const { store, sock, status } = setup();
    store.getState().submitInput(paste(8));
    store.getState().confirmPaste(true);
    expect(sock.privmsgs()).toHaveLength(1);
    vi.advanceTimersByTime(4 * 500);
    expect(sock.privmsgs()).toHaveLength(5);
    vi.advanceTimersByTime(5_000);
    expect(sock.privmsgs()).toHaveLength(5);
    expect(vi.getTimerCount()).toBe(0);
    expect(store.getState().client.paste.pending).toBeUndefined();
    expect(status().some((t) => t.includes("3 lines dropped"))).toBe(true);
  });

  it("decline leaves nothing queued and nothing is ever sent", { timeout: TIMEOUT_MS }, () => {
    const { store, sock, status } = setup();
    store.getState().submitInput(paste(6));
    store.getState().confirmPaste(false);
    vi.advanceTimersByTime(5_000);
    expect(sock.privmsgs()).toHaveLength(0);
    expect(store.getState().client.paste.queue).toHaveLength(0);
    expect(store.getState().client.paste.pending).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    expect(status().some((t) => t.includes("6 lines not sent"))).toBe(true);
  });

  it("disconnect empties the queue and cancels the pacing timer", { timeout: TIMEOUT_MS }, () => {
    const { store, sock, status } = setup();
    store.getState().submitInput(paste(4));
    sock.onclose?.({ code: 1006, reason: "", wasClean: false });
    expect(store.getState().client.paste.queue).toHaveLength(0);
    expect(status().some((t) => t.includes("3 queued messages not sent"))).toBe(true);
    vi.advanceTimersByTime(5_000);
    expect(sock.privmsgs()).toHaveLength(1);
  });
});
