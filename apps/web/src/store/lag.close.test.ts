// Lag review fixes: never negative, and unknown once the socket closes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClientStore } from "./client-store.js";
import type { SocketCloseInfo, WebSocketLike } from "./socket.js";
import { createClientStorage } from "./storage.js";

const ORIGIN = "ws://127.0.0.1:6680";
const LAG_MS = 30_000;

class FakeSocket implements WebSocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((e: { readonly data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: SocketCloseInfo) => void) | null = null;
  send(): void {}
  close(): void {}
}

function setup() {
  const sock = new FakeSocket();
  const clock = { t: 1_000_000 };
  const store = createClientStore({
    createSocket: () => sock,
    storage: createClientStorage(null, [ORIGIN]),
    now: () => clock.t,
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
    defaultServerUrl: ORIGIN,
    allowedOrigins: [ORIGIN],
  });
  store.getState().connect({ nick: "alice", serverUrl: ORIGIN, password: undefined });
  sock.onopen?.();
  sock.onmessage?.({ data: ":srv 001 alice :Welcome\r\n" });
  return { store, sock, clock };
}

describe("lag review fixes", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("clamps a negative round trip (clock went backwards) to 0", () => {
    const { store, sock, clock } = setup();
    vi.advanceTimersByTime(LAG_MS);
    clock.t -= 5_000;
    sock.onmessage?.({ data: ":srv PONG srv :seance-lag-1\r\n" });
    expect(store.getState().ui.lagSeconds).toBe(0);
  });

  it("resets lagSeconds to null when the socket closes", () => {
    const { store, sock, clock } = setup();
    vi.advanceTimersByTime(LAG_MS);
    clock.t += 250;
    sock.onmessage?.({ data: ":srv PONG srv :seance-lag-1\r\n" });
    expect(store.getState().ui.lagSeconds).toBe(0.25);
    sock.onclose?.({ code: 1006, reason: "", wasClean: false });
    expect(store.getState().ui.lagSeconds).toBeNull();
  });
});
