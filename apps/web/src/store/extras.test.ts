import { describe, expect, it } from "vitest";
import { createClientStore } from "./client-store.js";
import type { StoreDeps } from "./client-store.js";
import type { SocketCloseInfo, WebSocketLike } from "./socket.js";
import { THEME_KEY, createClientStorage } from "./storage.js";
import type { KeyValueBackend } from "./storage.js";

// web-client-extras: channel list actions (R1) and theme persistence (R3).

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

interface Timer {
  readonly fn: () => void;
  readonly ms: number;
  cleared: boolean;
}

function setup(data: Record<string, string> = {}, writeFails = false) {
  const socket = new FakeSocket();
  const timers: Timer[] = [];
  const backend: KeyValueBackend = {
    getItem: (k) => data[k] ?? null,
    setItem: (k, v) => {
      if (writeFails) throw new Error("quota");
      data[k] = v;
    },
  };
  const deps: StoreDeps = {
    createSocket: () => socket,
    storage: createClientStorage(backend, [ORIGIN]),
    now: () => 1000,
    setTimeout: (fn, ms) => {
      const t: Timer = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimeout: (h) => {
      (h as Timer).cleared = true;
    },
    defaultServerUrl: ORIGIN,
    allowedOrigins: [ORIGIN],
  };
  const store = createClientStore(deps);
  return { store, socket, timers, data };
}

function register(env: ReturnType<typeof setup>): void {
  env.store.getState().connect({ nick: "alice", serverUrl: ORIGIN, password: undefined });
  env.socket.onopen?.();
  env.socket.onmessage?.({ data: ":srv 001 alice :Welcome\r\n" });
}

const feed = (env: ReturnType<typeof setup>, line: string): void => {
  env.socket.onmessage?.({ data: `${line}\r\n` });
};

describe("channel list actions", () => {
  it("does nothing while not registered", () => {
    const env = setup();
    env.store.getState().openChannelList();
    expect(env.store.getState().ui.channelListOpen).toBe(false);
    expect(env.socket.sent).toEqual([]);
  });

  it("sends LIST, opens the dialog and fills the rows", () => {
    const env = setup();
    register(env);
    env.store.getState().openChannelList();
    expect(env.store.getState().ui.channelListOpen).toBe(true);
    expect(env.socket.sent.some((l) => l === "LIST\r\n")).toBe(true);
    feed(env, ":srv 322 alice #dev 3 :Fix it");
    feed(env, ":srv 323 alice :End of /LIST");
    const list = env.store.getState().client.list;
    expect(list?.status).toBe("ready");
    expect(list?.rows.map((r) => r.name)).toEqual(["#dev"]);
    // The NAMES count request for a channel without a window follows 323.
    expect(env.socket.sent.some((l) => l.startsWith("NAMES #dev"))).toBe(true);
  });

  it("marks the list failed when 323 does not arrive within 15 seconds", () => {
    const env = setup();
    register(env);
    env.store.getState().openChannelList();
    const timer = env.timers.find((t) => t.ms === 15_000 && !t.cleared);
    expect(timer).toBeDefined();
    timer?.fn();
    expect(env.store.getState().client.list?.status).toBe("failed");
  });

  it("refresh starts a new request and clears the old timer", () => {
    const env = setup();
    register(env);
    env.store.getState().openChannelList();
    feed(env, ":srv 322 alice #dev 3 :x");
    env.store.getState().refreshChannelList();
    expect(env.store.getState().client.list?.rows).toEqual([]);
    expect(env.store.getState().client.list?.status).toBe("loading");
    expect(env.timers.filter((t) => t.ms === 15_000 && t.cleared)).toHaveLength(1);
  });

  it("joinFromList sends JOIN and closes the dialog", () => {
    const env = setup();
    register(env);
    env.store.getState().openChannelList();
    env.store.getState().joinFromList("#dev");
    expect(env.socket.sent).toContain("JOIN #dev\r\n");
    expect(env.store.getState().ui.channelListOpen).toBe(false);
  });

  it("closes the dialog when the connection drops", () => {
    const env = setup();
    register(env);
    env.store.getState().openChannelList();
    env.socket.onclose?.({ code: 1006 } as SocketCloseInfo);
    expect(env.store.getState().ui.channelListOpen).toBe(false);
    expect(env.store.getState().client.list?.status).toBe("failed");
  });

  it("drops the list on a new connection", () => {
    const env = setup();
    register(env);
    env.store.getState().openChannelList();
    env.store.getState().quit();
    env.store.getState().connect({ nick: "alice", serverUrl: ORIGIN, password: undefined });
    expect(env.store.getState().client.list).toBeUndefined();
  });
});

describe("theme", () => {
  it("defaults to ghost and ignores an invalid stored value", () => {
    expect(setup().store.getState().ui.theme).toBe("ghost");
    for (const bad of ["neon", "<script>"]) {
      const env = setup({ [THEME_KEY]: bad });
      env.store.getState().loadStoredTheme();
      expect(env.store.getState().ui.theme).toBe("ghost");
    }
  });

  // Review finding 7 (intended change): the store starts as Ghost, like the server render; the stored
  // theme applies only through loadStoredTheme(), which ThemeSync calls after hydration.
  it("starts as ghost and applies a stored classic theme on loadStoredTheme without writing", () => {
    const env = setup({ [THEME_KEY]: "classic" });
    expect(env.store.getState().ui.theme).toBe("ghost");
    env.store.getState().loadStoredTheme();
    expect(env.store.getState().ui.theme).toBe("classic");
    expect(env.data).toEqual({ [THEME_KEY]: "classic" });
  });

  it("toggles and stores only the theme name", () => {
    const env = setup();
    env.store.getState().toggleTheme();
    expect(env.store.getState().ui.theme).toBe("classic");
    expect(env.data).toEqual({ [THEME_KEY]: "classic" });
    env.store.getState().toggleTheme();
    expect(env.data[THEME_KEY]).toBe("ghost");
  });

  it("keeps the theme and reports a Status line when the write fails", () => {
    const env = setup({}, true);
    env.store.getState().setTheme("classic");
    expect(env.store.getState().ui.theme).toBe("classic");
    const status = env.store.getState().client.windows["status"]?.lines.map((l) => l.text) ?? [];
    expect(status.some((t) => t.includes("saving the theme failed"))).toBe(true);
  });
});

describe("shortcuts dialog flag", () => {
  it("opens and closes", () => {
    const env = setup();
    env.store.getState().openShortcuts();
    expect(env.store.getState().ui.shortcutsOpen).toBe(true);
    env.store.getState().closeShortcuts();
    expect(env.store.getState().ui.shortcutsOpen).toBe(false);
  });
});
