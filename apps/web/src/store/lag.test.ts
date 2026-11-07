import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClientStore } from "./client-store.js";
import type { StoreDeps } from "./client-store.js";
import type { SocketCloseInfo, WebSocketLike } from "./socket.js";
import { createClientStorage } from "./storage.js";

const ORIGIN = "ws://127.0.0.1:6680";
const LAG_MS = 30_000;

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
  pings(): string[] {
    return this.sent.filter((l) => l.startsWith("PING"));
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const clock = { t: 1_000_000 };
  const deps: StoreDeps = {
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    storage: createClientStorage(null, [ORIGIN]),
    now: () => clock.t,
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof globalThis.setTimeout>),
    defaultServerUrl: ORIGIN,
    allowedOrigins: [ORIGIN],
  };
  const store = createClientStore(deps);
  store.getState().connect({ nick: "alice", serverUrl: ORIGIN, password: undefined });
  const sock = sockets[0];
  if (sock === undefined) throw new Error("no socket");
  sock.onopen?.();
  sock.recv(":srv 001 alice :Welcome\r\n");
  return { store, sock, clock };
}

describe("lag timer and MODE on join", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("sends MODE <channel> once after the own join only", () => {
    const { sock } = setup();
    sock.recv(":alice!u@h JOIN #test\r\n");
    sock.recv(":bob!u@h JOIN #test\r\n");
    sock.recv(":bob!u@h JOIN #other\r\n");
    expect(sock.sent.filter((l) => l.startsWith("MODE"))).toEqual(["MODE #test\r\n"]);
  });

  it("pairs a PONG with the outstanding ping and sets lagSeconds", () => {
    const { store, sock, clock } = setup();
    expect(store.getState().ui.lagSeconds).toBeNull();
    vi.advanceTimersByTime(LAG_MS);
    expect(sock.pings()).toEqual(["PING seance-lag-1\r\n"]);
    clock.t += 250;
    sock.recv(":srv PONG srv :seance-lag-1\r\n");
    expect(store.getState().ui.lagSeconds).toBe(0.25);
  });

  it("ignores a foreign PONG", () => {
    const { store, sock, clock } = setup();
    vi.advanceTimersByTime(LAG_MS);
    clock.t += 500;
    sock.recv(":srv PONG srv :something-else\r\n");
    expect(store.getState().ui.lagSeconds).toBeNull();
  });

  it("stops pinging after dispose", () => {
    const { store, sock } = setup();
    vi.advanceTimersByTime(LAG_MS);
    expect(sock.pings()).toHaveLength(1);
    store.getState().dispose();
    vi.advanceTimersByTime(LAG_MS * 3);
    expect(sock.pings()).toHaveLength(1);
  });
});

describe("P6 lag pairing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  // **Validates: Requirements 6.5**
  type Op =
    | { readonly kind: "tick"; readonly dt: number }
    | { readonly kind: "pong"; readonly token: number; readonly foreign: boolean; readonly dt: number };

  const opArb: fc.Arbitrary<Op> = fc.oneof(
    fc.record({ kind: fc.constant("tick" as const), dt: fc.integer({ min: 0, max: 5_000 }) }),
    fc.record({
      kind: fc.constant("pong" as const),
      token: fc.integer({ min: 0, max: 8 }),
      foreign: fc.boolean(),
      dt: fc.integer({ min: 0, max: 20_000 }),
    }),
  );

  it("P6 lag pairing: only the outstanding token updates lagSeconds", () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 30 }), (ops) => {
        const { store, sock, clock } = setup();
        let sent = 0;
        let outstanding: { readonly n: number; readonly at: number } | null = null;
        let expected: number | null = null;
        for (const op of ops) {
          if (op.kind === "tick") {
            vi.advanceTimersByTime(LAG_MS);
            sent += 1;
            outstanding = { n: sent, at: clock.t };
            clock.t += op.dt;
          } else {
            clock.t += op.dt;
            const name = op.foreign ? `other-${op.token}` : `seance-lag-${op.token}`;
            sock.recv(`:srv PONG srv :${name}\r\n`);
            if (!op.foreign && outstanding !== null && outstanding.n === op.token) {
              expected = (clock.t - outstanding.at) / 1000;
              outstanding = null;
            }
          }
          expect(store.getState().ui.lagSeconds).toBe(expected);
        }
        expect(sock.pings()).toHaveLength(sent);
        store.getState().dispose();
        vi.clearAllTimers();
      }),
      { numRuns: 50 },
    );
  });
});
