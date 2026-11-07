import { beforeEach, describe, expect, it, vi } from "vitest";

// Partial mock: `reduce` is a spy that defaults to the real implementation, so a test can
// make it throw once with `mockImplementationOnce`.
vi.mock("../irc/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../irc/index.js")>();
  return { ...actual, reduce: vi.fn(actual.reduce) };
});

import { reduce } from "../irc/index.js";
import { createClientStore } from "./client-store.js";
import type { StoreDeps } from "./client-store.js";
import type { SocketCloseInfo, WebSocketLike } from "./socket.js";
import { createClientStorage } from "./storage.js";
import type { KeyValueBackend } from "./storage.js";

class FakeSocket implements WebSocketLike {
  sent: string[] = [];
  closed: number | undefined;
  onopen: (() => void) | null = null;
  onmessage: ((e: { readonly data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: SocketCloseInfo) => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closed = code ?? 1005;
  }
  recv(data: unknown): void {
    this.onmessage?.({ data });
  }
}

const ORIGIN = "ws://127.0.0.1:6668";

function setup(initial: Record<string, string> = {}) {
  const sockets: FakeSocket[] = [];
  const data = new Map(Object.entries(initial));
  const backend: KeyValueBackend = {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
  const deps: StoreDeps = {
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    storage: createClientStorage(backend, [ORIGIN]),
    now: () => 1000,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    defaultServerUrl: ORIGIN,
    allowedOrigins: [ORIGIN],
  };
  const store = createClientStore(deps);
  const sock = (): FakeSocket => {
    const s = sockets[sockets.length - 1];
    if (s === undefined) throw new Error("no socket");
    return s;
  };
  return { store, sock, sockets };
}

type T = ReturnType<typeof setup>;

const statusText = (t: T): string[] => (t.store.getState().client.windows["status"]?.lines ?? []).map((l) => l.text);

function register(t: T, password?: string): void {
  t.store.getState().connect({ nick: "alice", serverUrl: ORIGIN, password });
  t.sock().onopen?.();
  t.sock().recv(":srv 001 alice :Welcome\r\n");
}

describe("store boundaries", { timeout: 10_000 }, () => {
  beforeEach(() => {
    vi.mocked(reduce).mockClear();
  });

  it("ignores a binary frame with a diagnostic and keeps processing", () => {
    const t = setup();
    register(t);
    t.sock().recv(new ArrayBuffer(4));
    expect(statusText(t).some((x) => x.includes("non-text"))).toBe(true);
    t.sock().sent.length = 0;
    t.sock().recv("PING :after\r\n");
    expect(t.sock().sent).toEqual(["PONG after\r\n"]);
  });

  it("closes the socket and reports an error for a frame above 64 KiB", () => {
    const t = setup();
    register(t);
    const s = t.sock();
    s.recv("x".repeat(64 * 1024 + 1));
    expect(s.closed).toBe(1009);
    expect(statusText(t).some((x) => x.startsWith("error:") && x.includes("larger than"))).toBe(true);
    // A registered session that closes goes back to disconnected (registering would be "failed").
    expect(t.store.getState().client.phase).toBe("disconnected");
  });

  it("discards an unparsable line and still processes later lines", () => {
    const t = setup();
    register(t);
    t.sock().sent.length = 0;
    t.sock().recv(":\r\nPING :next\r\n");
    expect(statusText(t).some((x) => x.includes("unparseable"))).toBe(true);
    expect(t.sock().sent).toEqual(["PONG next\r\n"]);
  });

  it("discards an overlong line and still processes later lines", () => {
    const t = setup();
    register(t);
    t.sock().sent.length = 0;
    t.sock().recv(`PRIVMSG #a :${"y".repeat(2000)}\r\nPING :next\r\n`);
    expect(statusText(t).some((x) => x.includes("overlong"))).toBe(true);
    expect(t.sock().sent).toEqual(["PONG next\r\n"]);
  });

  it("names the step and command when the reducer throws, then continues", () => {
    const t = setup();
    register(t);
    vi.mocked(reduce).mockImplementationOnce(() => {
      throw new Error("boom");
    });
    t.sock().sent.length = 0;
    t.sock().recv(":bob!u@h PRIVMSG #a :hi\r\nPING :next\r\n");
    const errors = statusText(t).filter((x) => x.startsWith("error:"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("reduce");
    expect(errors[0]).toContain("PRIVMSG");
    expect(errors[0]).toContain("boom");
    expect(t.sock().sent).toEqual(["PONG next\r\n"]);
    expect(t.store.getState().client.phase).toBe("registered");
  });

  it("reports a serialize failure without crashing", () => {
    const t = setup();
    t.store.getState().connect({ nick: "alice", serverUrl: ORIGIN, password: "p".repeat(600) });
    t.sock().onopen?.();
    const errors = statusText(t).filter((x) => x.startsWith("error:"));
    expect(errors.some((x) => x.includes("send failed on PASS"))).toBe(true);
    expect(t.sock().sent).toEqual(["NICK alice\r\n", "USER alice 0 * alice\r\n"]);
    expect(t.store.getState().client.phase).toBe("registering");
  });

  it("ignores invalid stored values", () => {
    const t = setup({ "seance.nick": "bad nick!", "seance.serverUrl": "ws://evil.example:1" });
    const ui = t.store.getState().ui;
    expect(ui.storedNick).toBeNull();
    expect(ui.serverUrl).toBe(ORIGIN);
  });

  it("keeps Chat_Buffers across a reconnect", () => {
    const t = setup();
    register(t);
    t.sock().recv(":alice!u@h JOIN #test\r\n:bob!u@h PRIVMSG #test :hello\r\n");
    const before = t.store.getState().client.windows["c:#test"]?.lines;
    expect(before?.some((l) => l.text === "hello")).toBe(true);
    t.sock().onclose?.({ code: 1006, reason: "", wasClean: false });
    t.store.getState().reconnect();
    expect(t.sockets).toHaveLength(2);
    expect(t.store.getState().client.windows["c:#test"]?.lines).toEqual(before);
  });
});
