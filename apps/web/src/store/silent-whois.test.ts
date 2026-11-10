import { describe, expect, it } from "vitest";
import {
  SILENT_WHOIS_DELAY_MS,
  SILENT_WHOIS_INTERVAL_MS,
  SILENT_WHOIS_TIMEOUT_MS,
  createClientStore,
} from "./client-store.js";
import type { StoreDeps } from "./client-store.js";
import type { SocketCloseInfo, WebSocketLike } from "./socket.js";
import { createClientStorage } from "./storage.js";

// web-client-extras R8.19 to R8.21: when the Store sends a silent WHOIS for the credits counter.

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

type Timer = { readonly fn: () => void; readonly at: number; cleared: boolean };

function setup() {
  let now = 1_000;
  const timers: Timer[] = [];
  const sockets: FakeSocket[] = [];
  const deps: StoreDeps = {
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    storage: createClientStorage({ getItem: () => null, setItem: () => undefined }, [ORIGIN]),
    now: () => now,
    setTimeout: (fn, ms) => {
      const t: Timer = { fn, at: now + ms, cleared: false };
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
  const sock = (): FakeSocket => {
    const s = sockets.at(-1);
    if (s === undefined) throw new Error("no socket");
    return s;
  };
  const feed = (line: string): void => {
    sock().onmessage?.({ data: `${line}\r\n` });
  };
  /** Moves virtual time on and fires every due, uncleared timer. */
  const advance = (ms: number): void => {
    now += ms;
    for (const t of [...timers]) {
      if (!t.cleared && t.at <= now) {
        t.cleared = true;
        t.fn();
      }
    }
  };
  /** Moves the clock without firing timers: a late timer. */
  const clockOnly = (ms: number): void => {
    now += ms;
  };
  const connect = (): void => {
    store.getState().connect({ nick: "alice", serverUrl: ORIGIN, password: undefined });
    sock().onopen?.();
    feed(":srv 001 alice :Welcome");
    feed(":alice!u@h JOIN #dev");
    feed(":srv 353 alice = #dev :@alice coder reviewer bob");
    feed(":srv 366 alice #dev :End of /NAMES list");
  };
  const whois = (): string[] => sock().sent.filter((l) => l.startsWith("WHOIS"));
  const pending = (): Timer[] => timers.filter((t) => !t.cleared);
  return { store, sock, feed, advance, clockOnly, connect, whois, pending };
}

describe("silent WHOIS triggers", () => {
  it("sends exactly one WHOIS 2 s after an agent's channel line", () => {
    const env = setup();
    env.connect();
    env.feed(":coder!c@h PRIVMSG #dev :done");
    env.advance(SILENT_WHOIS_DELAY_MS - 1);
    expect(env.whois()).toEqual([]);
    env.advance(1);
    expect(env.whois()).toEqual(["WHOIS coder\r\n"]);
    expect(env.store.getState().client.silentWhois).toEqual(["coder"]);
  });

  it("sends one WHOIS for ten agent lines within 30 s", () => {
    const env = setup();
    env.connect();
    for (let i = 0; i < 10; i++) {
      env.feed(`:coder!c@h PRIVMSG #dev :line ${String(i)}`);
      env.advance(2_500);
      // The reply ends the silent request, so only the rate limit can hold back the next one.
      env.feed(":srv 318 alice coder :End of /WHOIS list");
    }
    expect(env.whois()).toEqual(["WHOIS coder\r\n"]);
    // After the 30 s window a new line asks again.
    env.advance(SILENT_WHOIS_INTERVAL_MS);
    env.feed(":coder!c@h PRIVMSG #dev :later");
    env.advance(SILENT_WHOIS_DELAY_MS);
    expect(env.whois()).toEqual(["WHOIS coder\r\n", "WHOIS coder\r\n"]);
  });

  it("sends nothing for a human's line or a private agent message", () => {
    const env = setup();
    env.connect();
    env.feed(":bob!b@h PRIVMSG #dev :hi");
    env.feed(":coder!c@h PRIVMSG alice :psst");
    env.advance(60_000);
    expect(env.whois()).toEqual([]);
  });

  it("sends nothing while not registered", () => {
    const env = setup();
    env.store.getState().connect({ nick: "alice", serverUrl: ORIGIN, password: undefined });
    env.sock().onopen?.();
    env.feed(":coder!c@h PRIVMSG #dev :early");
    env.advance(60_000);
    expect(env.whois()).toEqual([]);
  });

  it("cancels the scheduled WHOIS and forgets the in-flight ones on disconnect", () => {
    const env = setup();
    env.connect();
    env.feed(":reviewer!r@h PRIVMSG #dev :first");
    env.advance(SILENT_WHOIS_DELAY_MS);
    env.feed(":coder!c@h PRIVMSG #dev :second");
    expect(env.pending().length).toBeGreaterThan(0);
    env.sock().onclose?.({ code: 1006 } as SocketCloseInfo);
    expect(env.store.getState().client.silentWhois).toEqual([]);
    env.advance(60_000);
    expect(env.whois()).toEqual(["WHOIS reviewer\r\n"]);
  });

  it("cancels the scheduled WHOIS on dispose", () => {
    const env = setup();
    env.connect();
    env.feed(":coder!c@h PRIVMSG #dev :done");
    env.store.getState().dispose();
    env.advance(60_000);
    expect(env.whois()).toEqual([]);
  });

  // Task 10.21 removed these triggers: a WHOIS of an agent in no channel carries no credits line.
  it("sends no WHOIS on the user's own KICK of an agent or on a ChanServ 'credits used' notice", () => {
    const env = setup();
    env.connect();
    env.feed(":srv 320 alice coder :credits: #dev 0.01 / total 0.01");
    env.feed(":srv 318 alice coder :End of /WHOIS list");
    env.feed(":alice!u@h KICK #dev coder :bye");
    env.feed(":ChanServ!s@services.seance.local NOTICE #dev :1 file reverted · 0.03 credits used");
    env.advance(60_000);
    expect(env.whois()).toEqual([]);
  });

  // With three Known_Agents the 3-in-flight cap is reached here; a fourth agent cannot exist yet.
  it("sends one silent WHOIS per speaking Known_Agent, up to 3 in flight", () => {
    const env = setup();
    env.connect();
    for (const nick of ["coder", "reviewer", "researcher"]) env.feed(`:${nick}!a@h PRIVMSG #dev :done`);
    env.advance(SILENT_WHOIS_DELAY_MS);
    expect(env.whois()).toEqual(["WHOIS coder\r\n", "WHOIS reviewer\r\n", "WHOIS researcher\r\n"]);
    expect(env.store.getState().client.silentWhois).toHaveLength(3);
  });

  // ---- task 10.21: timeout and the user's own errors -----------------------------------------

  const whoisLines = (env: ReturnType<typeof setup>) =>
    Object.values(env.store.getState().client.windows)
      .flatMap((w) => w.lines)
      .filter((l) => l.kind === "whois");

  it("ends a silent WHOIS without 318 after 10 s, printing nothing; a later /whois is sent and prints", () => {
    const env = setup();
    env.connect();
    env.feed(":coder!c@h PRIVMSG #dev :done");
    env.advance(SILENT_WHOIS_DELAY_MS);
    env.feed(":srv 311 alice coder coder seance.local * :coder (Seance agent)"); // ... then nothing
    env.advance(SILENT_WHOIS_TIMEOUT_MS - 1);
    expect(env.store.getState().client.silentWhois).toEqual(["coder"]);
    env.advance(1);
    expect(env.store.getState().client.silentWhois).toEqual([]);
    expect(Object.keys(env.store.getState().client.whoisPending)).toEqual([]);
    expect(whoisLines(env)).toEqual([]);

    env.store.getState().submitInput("/whois coder");
    expect(env.whois()).toEqual(["WHOIS coder\r\n", "WHOIS coder\r\n"]);
    env.feed(":srv 311 alice coder coder seance.local * :coder (Seance agent)");
    env.feed(":srv 318 alice coder :End of /WHOIS list");
    expect(whoisLines(env)).toHaveLength(1);
  });

  // ---- task 10.22: late replies after the timeout --------------------------------------------

  const allLines = (env: ReturnType<typeof setup>) =>
    Object.values(env.store.getState().client.windows).flatMap((w) => w.lines);

  /** Agent line, silent WHOIS sent, then 10 s without an answer. */
  const timedOut = (): ReturnType<typeof setup> => {
    const env = setup();
    env.connect();
    env.feed(":coder!c@h PRIVMSG #dev :done");
    env.advance(SILENT_WHOIS_DELAY_MS);
    env.advance(SILENT_WHOIS_TIMEOUT_MS);
    expect(env.store.getState().client.silentWhois).toEqual([]);
    expect(env.store.getState().client.silentExpired).toEqual(["coder"]);
    return env;
  };

  it("prints nothing for late 311, 301, 320 and 318 after the timeout, and the 320 still updates the counter", () => {
    const env = timedOut();
    const before = allLines(env).length;
    env.feed(":srv 311 alice coder coder seance.local * :coder (Seance agent)");
    env.feed(":srv 301 alice coder :running a tool");
    env.feed(":srv 320 alice coder :credits: #dev 0.02 / total 0.07");
    env.feed(":srv 318 alice coder :End of /WHOIS list");
    expect(allLines(env).length).toBe(before);
    expect(env.store.getState().client.credits["coder"]).toBe(0.07);
    expect(Object.keys(env.store.getState().client.whoisPending)).toEqual([]);
    expect(env.store.getState().client.silentExpired).toEqual([]);
  });

  it("ends a timed-out entry silently on a late 401", () => {
    const env = timedOut();
    const before = allLines(env).length;
    env.feed(":srv 401 alice coder :No such nick/channel");
    expect(allLines(env).length).toBe(before);
    expect(env.store.getState().client.silentExpired).toEqual([]);
  });

  it.each([
    ["after the late replies arrived", true],
    ["when no late reply ever comes", false],
  ] as const)("prints exactly one block for a user /whois after the timeout, %s", (_label, lateFirst) => {
    const env = timedOut();
    if (lateFirst) {
      env.feed(":srv 311 alice coder coder seance.local * :coder (Seance agent)");
      env.feed(":srv 318 alice coder :End of /WHOIS list");
    }
    env.store.getState().submitInput("/whois coder");
    expect(env.whois()).toEqual(["WHOIS coder\r\n", "WHOIS coder\r\n"]);
    expect(env.store.getState().client.silentExpired).toEqual([]);
    env.feed(":srv 311 alice coder coder seance.local * :coder (Seance agent)");
    env.feed(":srv 320 alice coder :credits: #dev 0.02 / total 0.08");
    env.feed(":srv 318 alice coder :End of /WHOIS list");
    expect(whoisLines(env)).toHaveLength(1);
    expect(env.store.getState().client.credits["coder"]).toBe(0.08);
  });

  it("empties the set of timed-out entries on disconnect", () => {
    const env = timedOut();
    env.sock().onclose?.({ code: 1006 } as SocketCloseInfo);
    expect(env.store.getState().client.silentExpired).toEqual([]);
  });

  it("does not swallow a /whois typed 11 s into a stuck silent WHOIS, even if its timer is late", () => {
    const env = setup();
    env.connect();
    env.feed(":coder!c@h PRIVMSG #dev :done");
    env.advance(SILENT_WHOIS_DELAY_MS);
    env.clockOnly(11_000); // the 10 s timer has not fired yet
    expect(env.store.getState().client.silentWhois).toEqual(["coder"]);
    env.store.getState().submitInput("/whois coder");
    expect(env.whois()).toEqual(["WHOIS coder\r\n", "WHOIS coder\r\n"]);
    expect(env.store.getState().client.silentWhois).toEqual([]);
    env.feed(":srv 311 alice coder coder seance.local * :coder (Seance agent)");
    env.feed(":srv 318 alice coder :End of /WHOIS list");
    expect(whoisLines(env)).toHaveLength(1);
  });

  it("shows a 401 that follows the user's /msg to a nick with a silent WHOIS in flight", () => {
    const env = setup();
    env.connect();
    env.feed(":coder!c@h PRIVMSG #dev :done");
    env.advance(SILENT_WHOIS_DELAY_MS);
    env.store.getState().submitInput("/msg coder are you there?");
    env.feed(":srv 401 alice coder :No such nick/channel");
    const errors = Object.values(env.store.getState().client.windows)
      .flatMap((w) => w.lines)
      .filter((l) => l.kind === "error" && l.text.includes("No such nick"));
    expect(errors).toHaveLength(1);
    expect(env.store.getState().client.silentWhois).toEqual([]);
  });

  it("shows a late 401 that follows the user's /msg to a nick whose silent WHOIS timed out", () => {
    const env = timedOut();
    env.store.getState().submitInput("/msg coder are you there?");
    env.feed(":srv 401 alice coder :No such nick/channel");
    const errors = Object.values(env.store.getState().client.windows)
      .flatMap((w) => w.lines)
      .filter((l) => l.kind === "error" && l.text.includes("No such nick"));
    expect(errors).toHaveLength(1);
    expect(env.store.getState().client.silentExpired).toEqual([]);
  });

  it("still swallows a 401 for a silent WHOIS when the user sent nothing to that nick", () => {
    const env = setup();
    env.connect();
    env.feed(":coder!c@h PRIVMSG #dev :done");
    env.advance(SILENT_WHOIS_DELAY_MS);
    env.store.getState().submitInput("/msg reviewer hello"); // another nick
    env.feed(":srv 401 alice coder :No such nick/channel");
    const errors = Object.values(env.store.getState().client.windows)
      .flatMap((w) => w.lines)
      .filter((l) => l.kind === "error");
    expect(errors).toEqual([]);
  });

  it("cancels the timeout of a silent WHOIS in flight on disconnect", () => {
    const env = setup();
    env.connect();
    env.feed(":coder!c@h PRIVMSG #dev :done");
    env.advance(SILENT_WHOIS_DELAY_MS);
    expect(env.pending()).toHaveLength(2); // the lag timer and the silent timeout
    env.sock().onclose?.({ code: 1006 } as SocketCloseInfo);
    expect(env.pending()).toEqual([]);
    expect(env.store.getState().client.silentWhois).toEqual([]);
  });

  it("does not send a second WHOIS when the user types /whois during a silent one, and prints the block", () => {
    const env = setup();
    env.connect();
    env.feed(":coder!c@h PRIVMSG #dev :done");
    env.advance(SILENT_WHOIS_DELAY_MS);
    env.store.getState().submitInput("/whois coder");
    expect(env.whois()).toEqual(["WHOIS coder\r\n"]);
    env.feed(":srv 311 alice coder coder seance.local * :coder (Seance agent)");
    env.feed(":srv 320 alice coder :credits: #dev 0.01 / total 0.04");
    env.feed(":srv 318 alice coder :End of /WHOIS list");
    const lines = Object.values(env.store.getState().client.windows).flatMap((w) => w.lines);
    expect(lines.filter((l) => l.kind === "whois")).toHaveLength(1);
    expect(env.store.getState().client.credits["coder"]).toBe(0.04);
  });
});
