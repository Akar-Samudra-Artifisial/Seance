import { describe, expect, it } from "vitest";
import { createClientStore } from "./client-store.js";
import type { MentionAudio } from "./client-store.js";
import type { SocketCloseInfo, WebSocketLike } from "./socket.js";
import { createClientStorage } from "./storage.js";

class FakeSocket implements WebSocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((e: { readonly data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((e: SocketCloseInfo) => void) | null = null;
  send(): void {}
  close(): void {}
  recv(data: string): void {
    this.onmessage?.({ data });
  }
}

const ORIGIN = "ws://127.0.0.1:6680";

function setup() {
  const sock = new FakeSocket();
  const log: string[] = [];
  const audio: MentionAudio = {
    unlock: () => log.push("unlock"),
    play: () => log.push("play"),
  };
  const store = createClientStore({
    createSocket: () => sock,
    storage: createClientStorage({ getItem: () => null, setItem: () => undefined }, [ORIGIN]),
    now: () => 1000,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    defaultServerUrl: ORIGIN,
    allowedOrigins: [ORIGIN],
    audio,
  });
  store.getState().connect({ nick: "alice", serverUrl: ORIGIN, password: undefined });
  sock.onopen?.();
  sock.recv(":srv 001 alice :Welcome\r\n");
  sock.recv(":alice!u@h JOIN #dev\r\n");
  return { store, sock, log };
}

describe("mention sound", () => {
  it("is off by default and silent on a mention", () => {
    const t = setup();
    expect(t.store.getState().ui.mentionSound).toBe(false);
    t.sock.recv(":bob!b@h PRIVMSG #dev :hi alice\r\n");
    expect(t.log).toEqual([]);
  });

  it("unlocks audio on enable and plays only for mentions", () => {
    const t = setup();
    t.store.getState().setMentionSound(true);
    expect(t.log).toEqual(["unlock"]);
    t.sock.recv(":bob!b@h PRIVMSG #dev :no ping here\r\n");
    t.sock.recv(":alice!u@h PRIVMSG #dev :alice talking\r\n");
    expect(t.log).toEqual(["unlock"]);
    t.sock.recv(":bob!b@h PRIVMSG #dev :hi alice\r\n");
    expect(t.log).toEqual(["unlock", "play"]);
  });

  it("stops playing after it is disabled", () => {
    const t = setup();
    t.store.getState().setMentionSound(true);
    t.store.getState().setMentionSound(false);
    t.sock.recv(":bob!b@h PRIVMSG #dev :hi alice\r\n");
    expect(t.log).toEqual(["unlock"]);
  });
});
