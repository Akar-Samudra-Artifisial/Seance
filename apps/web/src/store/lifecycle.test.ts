import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FRAME_MAX_BYTES } from "../irc/index.js";
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

function setup(backend: Record<string, string> = {}) {
  const socket = new FakeSocket();
  const timers: { id: number; fn: () => void }[] = [];
  const cleared: number[] = [];
  let next = 1;
  const store = createClientStore({
    createSocket: () => socket,
    storage: createClientStorage(
      {
        getItem: (k) => backend[k] ?? null,
        setItem: (k, v) => {
          backend[k] = v;
        },
      },
      [ORIGIN],
    ),
    now: () => 1000,
    setTimeout: (fn) => {
      const id = next++;
      timers.push({ id, fn });
      return id;
    },
    clearTimeout: (h) => {
      cleared.push(h as number);
    },
    defaultServerUrl: ORIGIN,
    allowedOrigins: [ORIGIN],
  });
  store.getState().connect({ nick: "alice", serverUrl: ORIGIN, password: undefined });
  socket.onopen?.();
  const recv = (line: string): void => socket.onmessage?.({ data: `${line}\r\n` });
  recv(":srv 001 alice :Welcome");
  recv(":alice!a@h JOIN #dev");
  return { store, socket, recv, timers, cleared, backend };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("dispose", () => {
  it("closes the socket and detaches its handlers", () => {
    const { store, socket } = setup();
    store.getState().dispose();
    expect(socket.closes).toHaveLength(1);
    expect(socket.onmessage).toBeNull();
    expect(socket.onclose).toBeNull();
  });

  it("clears the paste timer", () => {
    const { store, timers, cleared } = setup();
    store.getState().submitInput("a\nb\nc");
    store.getState().confirmPaste(true);
    expect(timers.length).toBeGreaterThan(0);
    const pending = timers[timers.length - 1]?.id;
    store.getState().dispose();
    expect(cleared).toContain(pending);
  });

  it("is safe to call without a connection and twice", () => {
    const { store } = setup();
    store.getState().dispose();
    expect(() => {
      store.getState().dispose();
    }).not.toThrow();
  });
});

describe("/quit", () => {
  it("sends QUIT exactly once", () => {
    const { store, socket } = setup();
    store.getState().submitInput("/quit bye");
    expect(socket.sent.filter((l) => l.startsWith("QUIT"))).toHaveLength(1);
    expect(socket.closes).toHaveLength(1);
  });

  it("the quit action sends QUIT once as well", () => {
    const { store, socket } = setup();
    store.getState().quit();
    expect(socket.sent.filter((l) => l.startsWith("QUIT"))).toHaveLength(1);
  });
});

describe("frame guard", () => {
  it("rejects an oversized frame by length before encoding it", () => {
    const { socket } = setup();
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    socket.onmessage?.({ data: "a".repeat(FRAME_MAX_BYTES + 1) });
    expect(encode).not.toHaveBeenCalled();
    expect(socket.closes).toContain(1009);
  });

  it("still rejects a frame that is short in characters but long in bytes", () => {
    const { socket } = setup();
    socket.onmessage?.({ data: "€".repeat(Math.ceil(FRAME_MAX_BYTES / 3) + 1) });
    expect(socket.closes).toContain(1009);
  });
});

describe("stored server URL", () => {
  const memory = () => {
    const data: Record<string, string> = {};
    return { data, backend: { getItem: (k: string) => data[k] ?? null, setItem: (k: string, v: string) => void (data[k] = v) } };
  };

  it("keeps the path when writing and still refuses a query", () => {
    const { data, backend } = memory();
    const storage = createClientStorage(backend, [ORIGIN]);
    storage.write({ nick: "alice", serverUrl: `${ORIGIN}/ws` });
    expect(data["seance.serverUrl"]).toBe(`${ORIGIN}/ws`);
    expect(() => {
      storage.write({ nick: "alice", serverUrl: `${ORIGIN}/ws?token=1` });
    }).toThrow(/refusing to store/);
    expect(() => {
      storage.write({ nick: "alice", serverUrl: `${ORIGIN}/ws#frag` });
    }).toThrow(/refusing to store/);
    expect(() => {
      storage.write({ nick: "alice", serverUrl: "ws://user:pw@127.0.0.1:6680/ws" });
    }).toThrow(/refusing to store/);
  });

  it("persists the full URL of the connection", () => {
    const backend: Record<string, string> = {};
    const { store } = setup(backend);
    expect(store.getState().ui.serverUrl).toBe(ORIGIN);
    expect(backend["seance.serverUrl"]).toBe(ORIGIN);
  });

  it("returns a stored URL with a path unchanged", () => {
    const { backend } = memory();
    const storage = createClientStorage(backend, [ORIGIN], `${ORIGIN}/ws`);
    storage.write({ nick: "alice", serverUrl: `${ORIGIN}/other/path` });
    expect(storage.read().serverUrl).toBe(`${ORIGIN}/other/path`);
  });

  it("migrates an origin-only value saved by an older client to the default URL", () => {
    const { data, backend } = memory();
    data["seance.serverUrl"] = ORIGIN;
    expect(createClientStorage(backend, [ORIGIN], `${ORIGIN}/ws`).read().serverUrl).toBe(`${ORIGIN}/ws`);
    data["seance.serverUrl"] = `${ORIGIN}/`;
    expect(createClientStorage(backend, [ORIGIN], `${ORIGIN}/ws`).read().serverUrl).toBe(`${ORIGIN}/ws`);
    // Without a default URL (or with a path-less one) the stored value is returned as it is.
    expect(createClientStorage(backend, [ORIGIN]).read().serverUrl).toBe(`${ORIGIN}/`);
  });

  it("does not migrate a path-less value whose origin differs from the default", () => {
    const { data, backend } = memory();
    const other = "wss://other.example";
    data["seance.serverUrl"] = other;
    expect(createClientStorage(backend, [ORIGIN, other], `${ORIGIN}/ws`).read().serverUrl).toBe(other);
  });

  it("P21 write(url) then read() returns the same url for any valid url with a path", () => {
    const segment = fc.stringMatching(/^[A-Za-z0-9._~-]{1,8}$/).filter((x) => x !== "." && x !== "..");
    const path = fc.array(segment, { minLength: 1, maxLength: 4 }).map((parts) => `/${parts.join("/")}`);
    const scheme = fc.constantFrom("ws", "wss");
    const host = fc.stringMatching(/^[a-z][a-z0-9]{0,8}(\.[a-z][a-z0-9]{0,8}){0,2}$/);
    const port = fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined });
    fc.assert(
      fc.property(scheme, host, port, path, (sch, h, prt, pth) => {
        const origin = `${sch}://${h}${prt === undefined ? "" : `:${prt}`}`;
        const url = `${origin}${pth}`;
        const { backend } = memory();
        // The default URL has a path of its own on the same origin: a stored path must win over it.
        const storage = createClientStorage(backend, [origin], `${origin}/ws`);
        storage.write({ nick: "alice", serverUrl: url });
        expect(storage.read().serverUrl).toBe(url);
      }),
      { numRuns: 200 },
    );
  });
});
