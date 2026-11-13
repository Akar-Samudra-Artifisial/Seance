import { describe, expect, it } from "vitest";
import { createClientStore } from "./client-store.js";
import type { SocketCloseInfo, WebSocketLike } from "./socket.js";
import { createClientStorage } from "./storage.js";

const ORIGIN = "ws://127.0.0.1:6680";

class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  closes: number[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { readonly data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: SocketCloseInfo) => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closes.push(code ?? 0);
  }
}

interface FakeTimer {
  readonly id: number;
  readonly ms: number;
  readonly fn: () => void;
  cleared: boolean;
  fired: boolean;
}

function setup() {
  const sockets: FakeSocket[] = [];
  const timers: FakeTimer[] = [];
  let next = 1;
  const store = createClientStore({
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    storage: createClientStorage({ getItem: () => null, setItem: () => undefined }, [ORIGIN]),
    now: () => 1000,
    setTimeout: (fn, ms) => {
      const t: FakeTimer = {
        id: next++,
        ms,
        fn: () => {
          t.fired = true;
          fn();
        },
        cleared: false,
        fired: false,
      };
      timers.push(t);
      return t.id;
    },
    clearTimeout: (h) => {
      const t = timers.find((x) => x.id === h);
      if (t !== undefined) t.cleared = true;
    },
    defaultServerUrl: ORIGIN,
    allowedOrigins: [ORIGIN],
  });
  const connect = (): void => {
    store.getState().connect({ nick: "alice", serverUrl: ORIGIN, password: undefined });
  };
  const armed = (): FakeTimer[] => timers.filter((t) => t.ms === 15_000 && !t.cleared && !t.fired);
  const sock = (i = 0): FakeSocket => {
    const s = sockets[i];
    if (s === undefined) throw new Error("no socket");
    return s;
  };
  const recv = (line: string, i = 0): void => sock(i).onmessage?.({ data: `${line}\r\n` });
  const client = () => store.getState().client;
  return { store, sockets, timers, connect, armed, sock, recv, client };
}

const CLOSE_1006: SocketCloseInfo = { code: 1006, reason: "", wasClean: false };
const TEXT = `No answer from ${ORIGIN} after 15 s`;

describe("connect timeout", () => {
  it("arms a 15000 ms timer on connect", () => {
    const { connect, armed } = setup();
    connect();
    expect(armed()).toHaveLength(1);
  });

  it("fails and closes the socket when it was never opened", () => {
    const { connect, armed, sock, client } = setup();
    connect();
    const s = sock();
    armed()[0]?.fn();
    expect(s.closes).toEqual([1000]);
    expect(client().phase).toBe("failed");
    expect(client().connectError).toEqual({ code: "socket", text: TEXT });
    s.onclose?.(CLOSE_1006);
    expect(client().phase).toBe("failed");
    expect(client().connectError).toEqual({ code: "socket", text: TEXT });
  });

  it("fails after open when 001 never arrives", () => {
    const { connect, armed, sock, client } = setup();
    connect();
    const s = sock();
    s.onopen?.();
    expect(client().phase).toBe("registering");
    armed()[0]?.fn();
    expect(s.closes).toEqual([1000]);
    expect(client().phase).toBe("failed");
    expect(client().connectError).toEqual({ code: "socket", text: TEXT });
    s.onclose?.(CLOSE_1006);
    expect(client().connectError).toEqual({ code: "socket", text: TEXT });
  });

  it("lets Connect work again after a timeout", () => {
    const { connect, armed, sockets, client } = setup();
    connect();
    armed()[0]?.fn();
    connect();
    expect(sockets).toHaveLength(2);
    expect(client().phase).toBe("connecting");
    expect(client().connectError).toBeUndefined();
    expect(armed()).toHaveLength(1);
  });

  it("is cleared by 001 and the stale timer then does nothing", () => {
    const { connect, armed, timers, sock, recv, client } = setup();
    connect();
    sock().onopen?.();
    const timer = armed()[0];
    recv(":srv 001 alice :Welcome");
    expect(client().phase).toBe("registered");
    expect(armed()).toHaveLength(0);
    timer?.fn();
    expect(client().phase).toBe("registered");
    expect(client().connectError).toBeUndefined();
    expect(sock().closes).toEqual([]);
    expect(timers.length).toBeGreaterThan(0);
  });

  it.each([
    ["464", "password", "Password incorrect"],
    ["433", "in-use", "Nickname is already in use"],
    ["432", "erroneous", "Erroneous nickname"],
  ] as const)("is cleared by %s and keeps its own error", (num, code, text) => {
    const { connect, armed, sock, recv, client } = setup();
    connect();
    sock().onopen?.();
    recv(`:srv ${num} * :${text}`);
    expect(armed()).toHaveLength(0);
    expect(client().phase).toBe("failed");
    expect(client().connectError).toEqual({ code, text });
  });

  it("is cleared by an early close, which keeps the Could not reach text", () => {
    const { connect, armed, sock, client } = setup();
    connect();
    sock().onclose?.(CLOSE_1006);
    expect(armed()).toHaveLength(0);
    expect(client().phase).toBe("failed");
    expect(client().connectError?.code).toBe("origin-or-network");
    expect(client().connectError?.text).toContain(`Could not reach ${ORIGIN}`);
  });

  it("keeps the registering close text", () => {
    const { connect, armed, sock, client } = setup();
    connect();
    sock().onopen?.();
    sock().onclose?.(CLOSE_1006);
    expect(armed()).toHaveLength(0);
    expect(client().connectError).toEqual({
      code: "socket",
      text: "The connection closed before registration completed.",
    });
  });

  it("cancelConnect closes a pending socket without an error", () => {
    const { store, connect, armed, sock, client } = setup();
    connect();
    store.getState().cancelConnect();
    expect(sock().closes).toEqual([1000]);
    expect(armed()).toHaveLength(0);
    expect(client().phase).toBe("disconnected");
    expect(client().connectError).toBeUndefined();
  });

  it("cancelConnect sends no QUIT when the socket was open", () => {
    const { store, connect, armed, sock, client } = setup();
    connect();
    sock().onopen?.();
    store.getState().cancelConnect();
    expect(sock().sent.filter((l) => l.startsWith("QUIT"))).toHaveLength(0);
    expect(sock().closes).toEqual([1000]);
    expect(armed()).toHaveLength(0);
    expect(client().phase).toBe("disconnected");
    expect(client().connectError).toBeUndefined();
  });

  it("cancelConnect is a no-op when idle", () => {
    const { store, client } = setup();
    store.getState().cancelConnect();
    expect(client().phase).toBe("disconnected");
  });

  it("cancelConnect is a no-op when registered", () => {
    const { store, connect, sock, recv, client } = setup();
    connect();
    sock().onopen?.();
    recv(":srv 001 alice :Welcome");
    store.getState().cancelConnect();
    expect(client().phase).toBe("registered");
    expect(sock().closes).toEqual([]);
  });

  it("leaves no armed connect timer after register, quit and dispose", () => {
    const { store, connect, armed, sock, recv } = setup();
    connect();
    sock().onopen?.();
    recv(":srv 001 alice :Welcome");
    store.getState().quit();
    store.getState().dispose();
    expect(armed()).toHaveLength(0);
  });

  it("quit clears a pending connect timer", () => {
    const { store, connect, armed } = setup();
    connect();
    store.getState().quit();
    expect(armed()).toHaveLength(0);
  });

  it("dispose clears a pending connect timer", () => {
    const { store, connect, armed } = setup();
    connect();
    store.getState().dispose();
    expect(armed()).toHaveLength(0);
  });

  it("a second connect clears the first timer", () => {
    const { connect, armed, timers } = setup();
    connect();
    connect();
    expect(timers.filter((t) => t.ms === 15_000)).toHaveLength(2);
    expect(timers[0]?.cleared).toBe(true);
    expect(armed()).toHaveLength(1);
  });
});
