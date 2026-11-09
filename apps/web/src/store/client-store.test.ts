import { describe, expect, it } from "vitest";
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

const ORIGIN = "ws://127.0.0.1:6680";

function setup(initial: Record<string, string> = {}) {
  const sockets: FakeSocket[] = [];
  const data = new Map(Object.entries(initial));
  const calls: string[] = [];
  const backend: KeyValueBackend = {
    getItem: (k) => {
      calls.push(`get ${k}`);
      return data.get(k) ?? null;
    },
    setItem: (k, v) => {
      calls.push(`set ${k}=${v}`);
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
  return { store, sock, data, sockets, calls };
}

const statusText = (store: ReturnType<typeof setup>["store"]): string[] =>
  (store.getState().client.windows["status"]?.lines ?? []).map((l) => l.text);

function register(t: ReturnType<typeof setup>, password?: string): void {
  t.store.getState().connect({ nick: "alice", serverUrl: ORIGIN, password });
  t.sock().onopen?.();
}

describe("client store", () => {
  it("rejects invalid nick and disallowed URL without opening a socket", () => {
    const t = setup();
    t.store.getState().connect({ nick: "1bad", serverUrl: "ws://evil.example:1", password: undefined });
    const ui = t.store.getState().ui;
    expect(ui.nickError).not.toBeNull();
    expect(ui.serverUrlError).not.toBeNull();
    expect(t.sockets).toHaveLength(0);
  });

  it("sends PASS only when set, then NICK and USER", () => {
    const a = setup();
    register(a);
    expect(a.sock().sent).toEqual(["NICK alice\r\n", "USER alice 0 * alice\r\n"]);
    const b = setup();
    register(b, "pw");
    expect(b.sock().sent[0]).toBe("PASS alice:pw\r\n");
    expect(b.store.getState().client.phase).toBe("registering");
  });

  it("registers on 001, persists nick and URL but never the password", () => {
    const t = setup();
    register(t, "secret");
    t.sock().recv(":srv 001 alice :Welcome\r\n");
    expect(t.store.getState().client.phase).toBe("registered");
    expect([...t.data.entries()]).toEqual([
      ["seance.nick", "alice"],
      ["seance.serverUrl", ORIGIN],
    ]);
  });

  it("ignores invalid stored values", () => {
    const t = setup({ "seance.nick": "9bad", "seance.serverUrl": "ws://evil.example:1" });
    expect(t.store.getState().ui.storedNick).toBeNull();
    expect(t.store.getState().ui.serverUrl).toBe(ORIGIN);
  });

  it("handles split frames, answers PING and survives bad input", () => {
    const t = setup();
    register(t);
    t.sock().sent.length = 0;
    t.sock().recv(":srv 001 alice :Wel");
    t.sock().recv("come\r\nPING :tok\r\n");
    expect(t.sock().sent).toEqual(["PONG tok\r\n"]);
    t.sock().recv(new ArrayBuffer(2));
    t.sock().recv(":\r\n");
    expect(statusText(t.store).some((x) => x.includes("non-text"))).toBe(true);
    expect(statusText(t.store).some((x) => x.includes("unparseable"))).toBe(true);
    expect(t.store.getState().client.phase).toBe("registered");
  });

  it("closes and reports an oversized frame", () => {
    const t = setup();
    register(t);
    t.sock().recv("x".repeat(64 * 1024 + 1));
    expect(t.sock().closed).toBe(1009);
    expect(statusText(t.store).some((x) => x.includes("larger than"))).toBe(true);
    expect(t.store.getState().client.phase).toBe("failed");
  });

  it("sets a connect error on 433 while registering", () => {
    const t = setup();
    register(t);
    t.sock().recv(":srv 433 * alice :Nickname is already in use\r\n");
    const c = t.store.getState().client;
    expect(c.phase).toBe("failed");
    expect(c.connectError?.code).toBe("in-use");
  });

  it("fails with an origin hint when the socket closes before open", () => {
    const t = setup();
    t.store.getState().connect({ nick: "alice", serverUrl: ORIGIN, password: undefined });
    t.sock().onclose?.({ code: 1006, reason: "", wasClean: false });
    const c = t.store.getState().client;
    expect(c.phase).toBe("failed");
    expect(c.connectError?.code).toBe("origin-or-network");
  });

  it("sends own PRIVMSG as one frame and echoes it in the active window", () => {
    const t = setup();
    register(t);
    t.sock().recv(":srv 001 alice :Welcome\r\n");
    t.sock().recv(":alice!a@h JOIN #dev\r\n");
    t.sock().sent.length = 0;
    t.store.getState().submitInput("hello there");
    expect(t.sock().sent).toEqual(["PRIVMSG #dev :hello there\r\n"]);
    const lines = t.store.getState().client.windows["c:#dev"]?.lines ?? [];
    expect(lines[lines.length - 1]).toMatchObject({ text: "hello there", own: true, from: "alice" });
  });

  it("setActiveWindow clears unread; reconnect keeps lines", () => {
    const t = setup();
    register(t);
    t.sock().recv(":srv 001 alice :Welcome\r\n");
    t.sock().recv(":alice!a@h JOIN #dev\r\n");
    t.sock().recv(":bob!b@h PRIVMSG alice :hi\r\n");
    expect(t.store.getState().client.windows["q:bob"]?.unread).toBe(true);
    t.store.getState().setActiveWindow("q:bob");
    expect(t.store.getState().client.windows["q:bob"]?.unread).toBe(false);
    t.sock().onclose?.({ code: 1006, reason: "", wasClean: false });
    expect(t.store.getState().client.phase).toBe("disconnected");
    t.store.getState().reconnect();
    expect(t.sockets).toHaveLength(2);
    expect(t.store.getState().client.windows["q:bob"]?.lines.length).toBeGreaterThan(0);
  });

  it("registration frames are PASS, NICK, USER in order with a password", () => {
    const t = setup();
    register(t, "pw");
    expect(t.sock().sent).toEqual(["PASS alice:pw\r\n", "NICK alice\r\n", "USER alice 0 * alice\r\n"]);
  });

  it("sends a plain secret as <nick>:<secret> and a value with a colon unchanged", () => {
    const plain = setup();
    register(plain, "s3cret");
    expect(plain.sock().sent[0]).toBe("PASS alice:s3cret\r\n");

    const account = setup();
    register(account, "bob:s3cret");
    expect(account.sock().sent[0]).toBe("PASS bob:s3cret\r\n");

    const trailing = setup();
    register(trailing, "a:b:c");
    expect(trailing.sock().sent[0]).toBe("PASS a:b:c\r\n");
  });

  it("sends no PASS for an undefined or empty password", () => {
    for (const password of [undefined, ""]) {
      const t = setup();
      register(t, password);
      expect(t.sock().sent.some((line) => line.startsWith("PASS"))).toBe(false);
    }
  });

  it("omits PASS for an empty password", () => {
    const t = setup();
    register(t, "");
    expect(t.sock().sent).toEqual(["NICK alice\r\n", "USER alice 0 * alice\r\n"]);
  });

  it.each([
    ["432", "erroneous"],
    ["464", "password"],
  ] as const)("sets the %s connect error and fails", (numeric, code) => {
    const t = setup();
    register(t);
    t.sock().recv(`:srv ${numeric} * alice :rejected\r\n`);
    const c = t.store.getState().client;
    expect(c.phase).toBe("failed");
    expect(c.connectError?.code).toBe(code);
    expect(c.connectError?.text).toBe("rejected");
  });

  it("fails when the socket closes after open but before 001", () => {
    const t = setup();
    register(t);
    t.sock().onclose?.({ code: 1006, reason: "", wasClean: false });
    const c = t.store.getState().client;
    expect(c.phase).toBe("failed");
    expect(c.connectError?.code).toBe("socket");
  });

  it("answers PING with PONG and adds no line", () => {
    const t = setup();
    register(t);
    t.sock().recv(":srv 001 alice :Welcome\r\n");
    const count = (): number =>
      Object.values(t.store.getState().client.windows).reduce((n, w) => n + w.lines.length, 0);
    const before = count();
    t.sock().sent.length = 0;
    t.sock().recv("PING :abc\r\n");
    expect(t.sock().sent).toEqual(["PONG abc\r\n"]);
    expect(count()).toBe(before);
  });

  it("never passes the password to any storage call", () => {
    const t = setup();
    register(t, "hunter2-secret");
    t.sock().recv(":srv 001 alice :Welcome\r\n");
    expect(t.calls.some((c) => c.startsWith("set "))).toBe(true);
    expect(t.calls.join("\n")).not.toContain("hunter2-secret");
    expect([...t.data.values()].join("\n")).not.toContain("hunter2-secret");
  });

  it("stores nick and URL on 001 only", () => {
    const t = setup();
    register(t);
    expect(t.calls.filter((c) => c.startsWith("set "))).toEqual([]);
    t.sock().recv(":srv 001 alice :Welcome\r\n");
    expect(t.calls.filter((c) => c.startsWith("set "))).toEqual([
      "set seance.nick=alice",
      `set seance.serverUrl=${ORIGIN}`,
    ]);
  });

  it("refuses a server URL outside the Connect_Src and names the allowed origins", () => {
    const t = setup();
    t.store.getState().connect({ nick: "alice", serverUrl: "ws://evil.example:1", password: undefined });
    const ui = t.store.getState().ui;
    expect(ui.nickError).toBeNull();
    expect(ui.serverUrlError).toContain(ORIGIN);
    expect(t.sockets).toHaveLength(0);
    expect(t.store.getState().client.phase).toBe("disconnected");
  });

  it("falls back to the default when the stored server URL is outside the Connect_Src", () => {
    const t = setup({ "seance.nick": "alice", "seance.serverUrl": "wss://evil.example" });
    expect(t.store.getState().ui.serverUrl).toBe(ORIGIN);
    expect(t.store.getState().ui.storedNick).toBe("alice");
    expect(t.sockets).toHaveLength(0);
  });

  it("quit sends QUIT then closes", () => {
    const t = setup();
    register(t);
    t.sock().recv(":srv 001 alice :Welcome\r\n");
    t.store.getState().quit();
    expect(t.sock().sent[t.sock().sent.length - 1]).toBe("QUIT Leaving\r\n");
    expect(t.sock().closed).toBe(1000);
    expect(t.store.getState().client.phase).toBe("disconnected");
  });
});
