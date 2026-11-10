import { describe, expect, it } from "vitest";
import { createClientStore } from "./client-store.js";
import type { StoreDeps } from "./client-store.js";
import type { SocketCloseInfo, WebSocketLike } from "./socket.js";
import { createClientStorage } from "./storage.js";
import type { KeyValueBackend } from "./storage.js";

// Audit fixes 10.1 to 10.4, 10.8 and 10.10 at the Store level.

const ORIGIN = "ws://127.0.0.1:6680";

class FakeSocket implements WebSocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((e: { readonly data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: SocketCloseInfo) => void) | null = null;
  readonly sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
}

function setup() {
  const sockets: FakeSocket[] = [];
  const data: Record<string, string> = {};
  const backend: KeyValueBackend = {
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      data[k] = v;
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
    setTimeout: () => ({}),
    clearTimeout: () => {},
    defaultServerUrl: ORIGIN,
    allowedOrigins: [ORIGIN],
  };
  const store = createClientStore(deps);
  const sock = (): FakeSocket => {
    const s = sockets.at(-1);
    if (s === undefined) throw new Error("no socket yet");
    return s;
  };
  const feed = (line: string): void => {
    sock().onmessage?.({ data: `${line}\r\n` });
  };
  const connect = (nick = "alice"): void => {
    store.getState().connect({ nick, serverUrl: ORIGIN, password: undefined });
    sock().onopen?.();
    feed(`:srv 001 ${nick} :Welcome`);
  };
  const join = (channel: string, names = "@alice coder reviewer"): void => {
    feed(`:alice!u@h JOIN ${channel}`);
    feed(`:srv 353 alice = ${channel} :${names}`);
    feed(`:srv 366 alice ${channel} :End of /NAMES list`);
  };
  const texts = (key: string): string[] => (store.getState().client.windows[key]?.lines ?? []).map((l) => l.text);
  return { store, sock, feed, connect, join, texts, data };
}

describe("/notice and /privmsg through the Store (10.1)", () => {
  it("sends multi-word text whole", () => {
    const env = setup();
    env.connect();
    env.store.getState().submitInput("/notice bob hello world");
    env.store.getState().submitInput("/privmsg bob and more words");
    expect(env.sock().sent).toContain("NOTICE bob :hello world\r\n");
    expect(env.sock().sent).toContain("PRIVMSG bob :and more words\r\n");
  });
});

describe("/help and /clear (10.2)", () => {
  it("/help prints into the active window and sends nothing; /clear empties it", () => {
    const env = setup();
    env.connect();
    env.join("#lab");
    const before = env.sock().sent.length;
    env.store.getState().submitInput("/help");
    expect(env.sock().sent.length).toBe(before);
    const key = env.store.getState().client.activeKey;
    expect(env.texts(key).some((t) => t.includes("/notice"))).toBe(true);
    env.store.getState().submitInput("/clear");
    expect(env.texts(key)).toEqual([]);
    expect(env.sock().sent.length).toBe(before);
  });
});

describe("Reconnect (10.3)", () => {
  it("rejoins every open channel window and reuses the nick the server confirmed", () => {
    const env = setup();
    env.connect();
    env.join("#a");
    env.join("#b");
    env.feed(":alice!u@h NICK alice2");
    env.store.getState().quit();
    expect(env.store.getState().ui.storedNick).toBe("alice2");
    env.store.getState().reconnect();
    const second = env.sock();
    second.onopen?.();
    expect(second.sent).toContain("NICK alice2\r\n");
    second.onmessage?.({ data: ":srv 001 alice2 :Welcome\r\n" });
    expect(second.sent).toContain("JOIN #a\r\n");
    expect(second.sent).toContain("JOIN #b\r\n");
  });
});

describe("closing the active window (10.4)", () => {
  it("activates the next window that is not minimised", () => {
    const env = setup();
    env.connect();
    env.join("#a");
    env.join("#b");
    env.store.getState().setActiveWindow("c:#b");
    env.store.getState().minimiseWindow("c:#a");
    env.store.getState().closeWindow("c:#b");
    env.feed(":alice!u@h PART #b");
    expect(env.store.getState().client.activeKey).toBe("status");
  });

  it("restores the Status_Window when everything else is minimised", () => {
    const env = setup();
    env.connect();
    env.join("#a");
    env.join("#b");
    env.store.getState().minimiseWindow("c:#a");
    env.store.getState().setActiveWindow("c:#b");
    env.store.getState().minimiseWindow("status");
    env.store.getState().closeWindow("c:#b");
    env.feed(":alice!u@h PART #b");
    const { client, ui } = env.store.getState();
    expect(client.activeKey).toBe("status");
    expect(ui.minimised).not.toContain("status");
    expect(ui.minimised).toContain("c:#a");
  });
});

describe("/list and /mode (10.8)", () => {
  it("/list opens the Channel list dialog and asks the server", () => {
    const env = setup();
    env.connect();
    env.store.getState().submitInput("/list");
    expect(env.store.getState().ui.channelListOpen).toBe(true);
    expect(env.sock().sent).toContain("LIST\r\n");
  });

  it("/mode #chan prints 324 and 329 into the channel window; the automatic query stays silent", () => {
    const env = setup();
    env.connect();
    env.join("#lab");
    env.feed(":srv 324 alice #lab +nt");
    expect(env.texts("c:#lab").some((t) => t.includes("+nt"))).toBe(false);
    env.store.getState().submitInput("/mode #lab");
    expect(env.sock().sent).toContain("MODE #lab\r\n");
    env.feed(":srv 324 alice #lab +nt");
    env.feed(":srv 329 alice #lab 1700000000");
    expect(env.texts("c:#lab").filter((t) => t.includes("+nt"))).toHaveLength(1);
    expect(env.texts("c:#lab").length).toBeGreaterThan(0);
  });
});

describe("Agents button (10.10)", () => {
  it("counts the agents of the active channel", () => {
    const env = setup();
    env.connect();
    env.join("#lab", "@alice coder reviewer");
    env.store.getState().announceAgents();
    expect(env.texts("c:#lab").at(-1)).toBe("2 agents in #lab");
  });

  it("says so when there are none", () => {
    const env = setup();
    env.connect();
    env.join("#empty", "@alice bob");
    env.store.getState().announceAgents();
    expect(env.texts("c:#empty").at(-1)).toBe("No agents in #empty");
  });
});
