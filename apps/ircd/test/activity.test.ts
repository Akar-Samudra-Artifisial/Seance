import { parse } from "@seance/irc-protocol";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { ConnectionSession } from "../src/network-client.js";
import type { Wire } from "../src/network-client.js";
import { createServer } from "../src/server.js";
import type { IrcServer } from "../src/server.js";

// Feature: ircd-agent-commands, Requirements 4.1-4.6 (sign-on and activity stamps)

const START_MS = 1_700_000_000_000;

interface Peer {
  readonly id: string;
  send(line: string): void;
}

interface Harness {
  readonly server: IrcServer;
  /** Advance the fake clock by whole seconds. */
  advance(seconds: number): void;
  /** Current fake time in whole Unix seconds. */
  nowSec(): number;
  connect(kind: "network" | "virtual", id: string, nick: string): Peer;
  stamps(id: string): { readonly signonAt: number | undefined; readonly lastActivityAt: number | undefined };
}

function harness(): Harness {
  let nowMs = START_MS;
  const server = createServer(loadConfig({}), { error: () => {} }, { now: () => nowMs });

  const register = (peer: Peer, nick: string): Peer => {
    peer.send(`NICK ${nick}`);
    peer.send(`USER ${nick} 0 * :${nick}`);
    return peer;
  };

  return {
    server,
    advance: (seconds) => {
      nowMs += seconds * 1000;
    },
    nowSec: () => Math.floor(nowMs / 1000),
    connect(kind, id, nick) {
      if (kind === "network") {
        const wire: Wire = {
          write: () => {},
          end: () => {},
          destroy: () => {},
          bufferedBytes: () => 0,
          isDestroyed: () => false,
        };
        const session = new ConnectionSession(server.ctx, server.router, id, undefined, wire);
        return register({ id, send: (line) => session.receive(`${line}\r\n`) }, nick);
      }
      const client = server.createVirtualClient({ id });
      return register(
        {
          id,
          send: (line) => {
            const msg = parse(line);
            if (!("command" in msg)) throw new Error(`Test line did not parse: ${line}`);
            client.dispatch(msg);
          },
        },
        nick,
      );
    },
    stamps(id) {
      const c = server.ctx.connections.get(id);
      if (c === undefined) throw new Error(`client ${id} not tracked`);
      return { signonAt: c.signonAt, lastActivityAt: c.lastActivityAt };
    },
  };
}

describe.each(["network", "virtual"] as const)("activity stamps for %s clients", (kind) => {
  it("records sign-on and last activity equal at registration (Req 4.1, 4.4, 4.5)", () => {
    const h = harness();
    h.connect(kind, "a", "alice");
    const now = h.nowSec();
    expect(now).toBe(Math.floor(START_MS / 1000));
    expect(h.stamps("a")).toEqual({ signonAt: now, lastActivityAt: now });
  });

  it("does not stamp before registration completes", () => {
    const h = harness();
    const c = h.server.createVirtualClient({ id: "x" });
    expect(c.signonAt).toBeUndefined();
    expect(c.lastActivityAt).toBeUndefined();
  });

  it("stamps last activity on PRIVMSG to a channel, leaving sign-on (Req 4.2, 4.4)", () => {
    const h = harness();
    const signon = h.nowSec();
    const a = h.connect(kind, "a", "alice");
    h.connect(kind, "b", "bob");
    a.send("JOIN #t");
    h.advance(30);
    a.send("PRIVMSG #t :hello");
    expect(h.stamps("a")).toEqual({ signonAt: signon, lastActivityAt: signon + 30 });
  });

  it("stamps last activity on PRIVMSG to a nick", () => {
    const h = harness();
    const a = h.connect(kind, "a", "alice");
    h.connect(kind, "b", "bob");
    h.advance(12);
    a.send("PRIVMSG bob :psst");
    expect(h.stamps("a").lastActivityAt).toBe(h.nowSec());
    expect(h.stamps("b").lastActivityAt).toBe(h.stamps("b").signonAt);
  });

  it("stamps last activity on NOTICE to a nick and to a channel", () => {
    const h = harness();
    const a = h.connect(kind, "a", "alice");
    h.connect(kind, "b", "bob");
    a.send("JOIN #t");
    h.advance(5);
    a.send("NOTICE bob :fyi");
    expect(h.stamps("a").lastActivityAt).toBe(h.nowSec());
    h.advance(7);
    a.send("NOTICE #t :fyi");
    expect(h.stamps("a").lastActivityAt).toBe(h.nowSec());
  });

  it("does not stamp on PING, PONG, JOIN or MODE (Req 4.3)", () => {
    const h = harness();
    const signon = h.nowSec();
    const a = h.connect(kind, "a", "alice");
    h.advance(10);
    a.send("PING token");
    a.send("PONG token");
    a.send("JOIN #t");
    a.send("MODE #t +m");
    a.send("MODE #t");
    expect(h.stamps("a").lastActivityAt).toBe(signon);
  });

  it.each([
    ["no recipient", "PRIVMSG"],
    ["no text", "PRIVMSG bob"],
    ["empty text", "PRIVMSG bob :"],
    ["no such nick", "PRIVMSG ghost :hi"],
    ["no such channel", "PRIVMSG #nope :hi"],
    ["notice to no such nick", "NOTICE ghost :hi"],
    ["notice no text", "NOTICE bob"],
  ])("does not stamp on a rejected send: %s (Req 4.6)", (_name, line) => {
    const h = harness();
    const signon = h.nowSec();
    const a = h.connect(kind, "a", "alice");
    h.connect(kind, "b", "bob");
    h.advance(20);
    a.send(line);
    expect(h.stamps("a").lastActivityAt).toBe(signon);
  });

  it("does not stamp when a non-member cannot send to a channel (Req 4.6)", () => {
    const h = harness();
    const signon = h.nowSec();
    const a = h.connect(kind, "a", "alice");
    const b = h.connect(kind, "b", "bob");
    b.send("JOIN #t");
    h.advance(20);
    a.send("PRIVMSG #t :let me in");
    expect(h.stamps("a").lastActivityAt).toBe(signon);
  });

  it("keeps an earlier stamp after a later rejected send", () => {
    const h = harness();
    const a = h.connect(kind, "a", "alice");
    h.connect(kind, "b", "bob");
    h.advance(3);
    a.send("PRIVMSG bob :ok");
    const stamped = h.nowSec();
    h.advance(50);
    a.send("PRIVMSG ghost :nope");
    expect(h.stamps("a").lastActivityAt).toBe(stamped);
  });
});

describe("sign-on time", () => {
  it("is taken per client at its own registration time", () => {
    const h = harness();
    h.connect("network", "a", "alice");
    h.advance(100);
    h.connect("virtual", "v", "vera");
    expect(h.stamps("v").signonAt).toBe(h.stamps("a").signonAt! + 100);
  });
});
