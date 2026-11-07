import { connect, createServer as createNetServer } from "node:net";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import * as hostModule from "../src/host.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import type { IrcServer } from "../src/server.js";

// Wrap the real normalizeHost so tests can see what the transports pass in and store.
vi.mock("../src/host.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/host.js")>();
  return { ...actual, normalizeHost: vi.fn(actual.normalizeHost) };
});

/** True when the machine can bind and connect over IPv6 loopback. */
async function ipv6LoopbackAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createNetServer();
    probe.once("error", () => resolve(false));
    probe.listen(0, "::1", () => {
      const port = (probe.address() as { port: number }).port;
      const c = connect(port, "::1");
      c.once("connect", () => {
        c.destroy();
        probe.close(() => resolve(true));
      });
      c.once("error", () => probe.close(() => resolve(false)));
    });
  });
}
const hasIpv6 = await ipv6LoopbackAvailable();

interface Peer {
  send(raw: string): void;
  waitFor(pattern: RegExp): Promise<string>;
  close(): void;
}

function makePeer(
  sendRaw: (raw: string) => void,
  closeRaw: () => void,
): { peer: Peer; push: (data: string) => void } {
  let buffer = "";
  const waiters: { pattern: RegExp; resolve: (s: string) => void }[] = [];
  const check = (): void => {
    for (const w of [...waiters]) {
      const m = w.pattern.exec(buffer);
      if (m !== null) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m[0]);
      }
    }
  };
  return {
    push(data) {
      buffer += data;
      check();
    },
    peer: {
      send: sendRaw,
      close: closeRaw,
      waitFor(pattern) {
        return new Promise<string>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`timeout waiting for ${pattern}; got: ${buffer}`)),
            3000,
          );
          waiters.push({
            pattern,
            resolve: (s) => {
              clearTimeout(timer);
              resolve(s);
            },
          });
          check();
        });
      },
    },
  };
}

function tcpPeer(port: number, host = "127.0.0.1"): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(port, host);
    const { peer, push } = makePeer(
      (raw) => socket.write(raw),
      () => socket.destroy(),
    );
    socket.setEncoding("utf8");
    socket.on("data", (d: string) => push(d));
    socket.once("error", reject);
    socket.once("connect", () => resolve(peer));
  });
}

function wsPeer(port: number, host = "127.0.0.1"): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${host.includes(":") ? `[${host}]` : host}:${port}`);
    const { peer, push } = makePeer(
      (raw) => ws.send(raw),
      () => ws.terminate(),
    );
    ws.on("message", (d) => push(d.toString()));
    ws.once("error", reject);
    ws.once("open", () => resolve(peer));
  });
}

describe("transports", () => {
  let server: IrcServer | undefined;
  const peers: Peer[] = [];

  afterEach(async () => {
    for (const p of peers.splice(0)) p.close();
    await server?.stop();
    server = undefined;
  });

  async function start(bind = "127.0.0.1"): Promise<{ tcpPort: number; wsPort: number }> {
    server = createServer(
      loadConfig({ IRCD_TCP_PORT: "0", IRCD_WS_PORT: "0", IRCD_HOST: bind }),
      { error: () => {} },
    );
    return server.start();
  }

  it("two TCP clients and a WebSocket client chat in #test", async () => {
    const { tcpPort, wsPort } = await start();
    const alice = await tcpPeer(tcpPort);
    const bob = await tcpPeer(tcpPort);
    const carol = await wsPeer(wsPort);
    peers.push(alice, bob, carol);

    alice.send("NICK alice\r\nUSER alice 0 * :Alice\r\n");
    bob.send("NICK bob\r\nUSER bob 0 * :Bob\r\n");
    // A frame split mid-line must be buffered until completed (Req 2.4).
    carol.send("NICK carol\r\nUSER car");
    carol.send("ol 0 * :Carol\r\n");
    await Promise.all([
      alice.waitFor(/ 001 alice /),
      bob.waitFor(/ 001 bob /),
      carol.waitFor(/ 001 carol /),
    ]);

    for (const p of [alice, bob, carol]) p.send("JOIN #test\r\n");
    await Promise.all([bob.waitFor(/ 366 bob #test/), carol.waitFor(/ 366 carol #test/)]);

    alice.send("PRIVMSG #test :hello séance\r\n");
    await bob.waitFor(/:alice!\S+ PRIVMSG #test :hello séance\r\n/);
    await carol.waitFor(/:alice!\S+ PRIVMSG #test :hello séance\r\n/);
  });

  it("replies 417 to an overlong line and keeps the connection open", async () => {
    const { tcpPort } = await start();
    const c = await tcpPeer(tcpPort);
    peers.push(c);
    c.send(`${"A".repeat(600)}\r\nNICK dave\r\nUSER dave 0 * :Dave\r\n`);
    await c.waitFor(/ 417 \* :Input line was too long\r\n/);
    await c.waitFor(/ 001 dave /);
  });

  it("socket close releases the nick via a synthetic QUIT", async () => {
    const { tcpPort } = await start();
    const a = await tcpPeer(tcpPort);
    peers.push(a);
    a.send("NICK eve\r\nUSER eve 0 * :Eve\r\n");
    await a.waitFor(/ 001 eve /);
    a.close();
    const b = await tcpPeer(tcpPort);
    peers.push(b);
    // Retry until the server has processed the close.
    for (let i = 0; i < 50 && server?.ctx.connections.isNickInUse("eve") === true; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    b.send("NICK eve\r\nUSER eve 0 * :Eve\r\n");
    await b.waitFor(/ 001 eve /);
  });
});

describe("peer host", () => {
  let server: IrcServer | undefined;
  const peers: Peer[] = [];
  const normalize = vi.mocked(hostModule.normalizeHost);
  afterEach(async () => {
    for (const p of peers.splice(0)) p.close();
    await server?.stop();
    server = undefined;
    normalize.mockClear();
  });

  async function start(bind: string): Promise<{ tcpPort: number; wsPort: number }> {
    server = createServer(
      loadConfig({ IRCD_TCP_PORT: "0", IRCD_WS_PORT: "0", IRCD_HOST: bind }),
      { error: () => {} },
    );
    return server.start();
  }

  /** Register, join a channel and return the host from our own JOIN prefix. */
  async function joinHost(peer: Peer, nick: string): Promise<string> {
    peers.push(peer);
    peer.send(`NICK ${nick}\r\nUSER ${nick} 0 * :${nick}\r\n`);
    await peer.waitFor(new RegExp(` 001 ${nick} `));
    peer.send("JOIN #host\r\n");
    const line = await peer.waitFor(new RegExp(`:${nick}!\\S+@\\S+ JOIN #host`));
    const m = /@(\S+) JOIN/.exec(line);
    if (m?.[1] === undefined) throw new Error(`no host in JOIN prefix: ${line}`);
    return m[1];
  }

  type Kind = "tcp" | "ws";
  const connectors: Record<Kind, (t: { tcpPort: number; wsPort: number }, h: string) => Promise<Peer>> = {
    tcp: (t, h) => tcpPeer(t.tcpPort, h),
    ws: (t, h) => wsPeer(t.wsPort, h),
  };

  for (const kind of ["tcp", "ws"] as const) {
    it(`${kind}: IPv4 peer host is the dotted quad`, async () => {
      const ports = await start("127.0.0.1");
      const host = await joinHost(await connectors[kind](ports, "127.0.0.1"), "ipfour");
      expect(host).toBe("127.0.0.1");
    });

    it(`${kind}: IPv4-mapped peer on a '::' bound server is the dotted quad`, async () => {
      const ports = await start("::");
      const host = await joinHost(await connectors[kind](ports, "127.0.0.1"), "mapped");
      expect(host).toBe("127.0.0.1");
      expect(normalize).toHaveBeenCalledWith("::ffff:127.0.0.1");
    });

    it.skipIf(!hasIpv6)(`${kind}: ::1 peer host gets a leading 0`, async () => {
      const ports = await start("::1");
      const host = await joinHost(await connectors[kind](ports, "::1"), "loopsix");
      expect(host).toBe("0::1");
      expect(host.startsWith(":")).toBe(false);
    });

    it(`${kind}: calls normalizeHost with the raw remoteAddress and stores its result`, async () => {
      const ports = await start("::");
      const host = await joinHost(await connectors[kind](ports, "127.0.0.1"), "wrapped");
      const matches = normalize.mock.calls
        .map((args, i) => ({ arg: args[0], result: normalize.mock.results[i]?.value as unknown }))
        .filter((c) => c.arg === "::ffff:127.0.0.1");
      expect(matches.length).toBeGreaterThanOrEqual(1);
      // The raw address was passed in, and the stored host is exactly what came back.
      expect(matches.every((c) => c.result === host)).toBe(true);
    });
  }
});

describe("loadConfig", () => {
  it("applies defaults", () => {
    expect(loadConfig({})).toMatchObject({ tcpPort: 6667, serverName: "seance.local" });
  });

  it("defaults the WebSocket port to 6680, which browsers allow", () => {
    expect(loadConfig({}).wsPort).toBe(6680);
  });

  it("refuses WebSocket ports 6665-6669 with a clear error but keeps TCP 6667", () => {
    for (const p of ["6665", "6666", "6667", "6668", "6669"]) {
      expect(() => loadConfig({ IRCD_WS_PORT: p })).toThrow(/IRCD_WS_PORT .*blocked by browsers/);
    }
    expect(loadConfig({ IRCD_WS_PORT: "6664" }).wsPort).toBe(6664);
    expect(loadConfig({ IRCD_WS_PORT: "6670" }).wsPort).toBe(6670);
    expect(loadConfig({ IRCD_WS_PORT: "0" }).wsPort).toBe(0);
    expect(loadConfig({ IRCD_TCP_PORT: "6667" }).tcpPort).toBe(6667);
  });

  it("rejects bad ports without echoing the password", () => {
    expect(() => loadConfig({ IRCD_TCP_PORT: "99999" })).toThrow(/IRCD_TCP_PORT/);
    let message = "";
    try {
      loadConfig({ IRCD_SERVER_PASSWORD: "bad pw" });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/IRCD_SERVER_PASSWORD/);
    expect(message).not.toContain("bad pw");
  });
});
