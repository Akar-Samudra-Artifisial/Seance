import { connect } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { serialize } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import { clampBytes, clampTrailing } from "../src/text-limits.js";
import { loadConfig } from "../src/config.js";
import { DEFAULT_LIMITS, ConnectionGate } from "../src/limits.js";
import type { SessionLimits } from "../src/limits.js";
import { ConnectionSession } from "../src/network-client.js";
import type { Wire } from "../src/network-client.js";
import { isOriginAllowed, parseAllowedOrigins } from "../src/origin.js";
import { createServer } from "../src/server.js";
import type { IrcServer } from "../src/server.js";
import { TokenBucket } from "../src/token-bucket.js";
import { safeEqual, validateUser } from "../src/handlers/registration.js";
import type { VirtualClient } from "../src/virtual-client.js";

const quiet = { error: () => {} };

function virtualWorld(env: Record<string, string> = {}) {
  const server = createServer(loadConfig(env), quiet);
  const inbox = new Map<string, IrcMessage[]>();
  const make = (id: string, nick: string, host?: string): VirtualClient => {
    const client = server.createVirtualClient(host === undefined ? { id } : { id, host });
    const msgs: IrcMessage[] = [];
    inbox.set(id, msgs);
    client.onMessage((m) => msgs.push(m));
    client.dispatch({ command: "NICK", params: [nick] });
    client.dispatch({ command: "USER", params: [nick, "0", "*", nick] });
    return client;
  };
  const got = (id: string, command: string): IrcMessage[] =>
    (inbox.get(id) ?? []).filter((m) => m.command === command);
  return { server, make, got, inbox };
}

const bytes = (m: IrcMessage): number => Buffer.byteLength(serialize(m), "utf8");

describe("1. virtual clients: keep-alive and close", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("never receives PING or a ping timeout", () => {
    const { server, make, inbox } = virtualWorld({
      IRCD_IDLE_INTERVAL_MS: "1000",
      IRCD_PING_TIMEOUT_MS: "1000",
    });
    make("v1", "agent");
    vi.advanceTimersByTime(60_000);
    expect(inbox.get("v1")?.some((m) => m.command === "PING" || m.command === "ERROR")).toBe(false);
    expect(server.ctx.connections.get("v1")).toBeDefined();
  });

  it("does not start keep-alive timers when a virtual client sends commands", () => {
    const { server, make, inbox } = virtualWorld({
      IRCD_IDLE_INTERVAL_MS: "1000",
      IRCD_PING_TIMEOUT_MS: "1000",
    });
    const a = make("v1", "agent");
    a.dispatch({ command: "JOIN", params: ["#t"] });
    vi.advanceTimersByTime(60_000);
    expect(inbox.get("v1")?.some((m) => m.command === "PING")).toBe(false);
    expect(server.ctx.connections.get("v1")).toBeDefined();
  });

  it("still pings network-style clients", () => {
    const { server } = virtualWorld({ IRCD_IDLE_INTERVAL_MS: "1000", IRCD_PING_TIMEOUT_MS: "1000" });
    const sent: IrcMessage[] = [];
    server.ctx.connections.add({
      id: "net",
      registered: true,
      send: (m) => sent.push(m),
      close: () => {},
    });
    vi.advanceTimersByTime(1000);
    expect(sent.map((m) => m.command)).toEqual(["PING"]);
  });

  it("close() quits like a network client: QUIT to peers, leaves channels, frees the nick", () => {
    const { server, make, got } = virtualWorld();
    const a = make("v1", "agent");
    const b = make("v2", "bob");
    a.dispatch({ command: "JOIN", params: ["#t"] });
    b.dispatch({ command: "JOIN", params: ["#t"] });
    a.close("shutting down");
    expect(got("v2", "QUIT")).toEqual([
      { prefix: expect.stringMatching(/^agent!/), command: "QUIT", params: ["shutting down"] },
    ]);
    expect([...(server.ctx.channels.get("#t")?.members.keys() ?? [])]).toEqual(["v2"]);
    expect(server.ctx.connections.isNickInUse("agent")).toBe(false);
    expect(server.ctx.connections.get("v1")).toBeUndefined();
    a.close("again"); // idempotent
    expect(got("v2", "QUIT")).toHaveLength(1);
  });
});

describe("2. relayed text is clamped to the line limit", () => {
  const HOST = "h".repeat(40);
  const NICK = "alice_the_long";

  function pair() {
    const world = virtualWorld();
    const a = world.make("v1", NICK, HOST);
    const b = world.make("v2", "bob");
    a.dispatch({ command: "JOIN", params: ["#t"] });
    b.dispatch({ command: "JOIN", params: ["#t"] });
    return { ...world, a, b };
  }
  const long = "é".repeat(235); // 470 bytes: fits when sent, too long once relayed

  it.each(["PRIVMSG", "NOTICE"])("%s is delivered shortened, not dropped", (command) => {
    const { a, got } = pair();
    a.dispatch({ command, params: ["#t", long] });
    const relayed = got("v2", command)[0];
    expect(relayed).toBeDefined();
    const text = relayed?.params[1] ?? "";
    expect(bytes(relayed as IrcMessage)).toBeLessThanOrEqual(512);
    expect(bytes(relayed as IrcMessage)).toBeGreaterThanOrEqual(509);
    expect(long.startsWith(text)).toBe(true);
    expect(text).not.toContain("\uFFFD");
    expect(text.length).toBeLessThan(long.length);
  });

  it("PRIVMSG to a user is clamped too", () => {
    const { a, got } = pair();
    a.dispatch({ command: "PRIVMSG", params: ["bob", long] });
    const relayed = got("v2", "PRIVMSG")[0] as IrcMessage;
    expect(bytes(relayed)).toBeLessThanOrEqual(512);
  });

  it("short text is relayed unchanged", () => {
    const { a, got } = pair();
    a.dispatch({ command: "PRIVMSG", params: ["#t", "hello"] });
    expect(got("v2", "PRIVMSG")[0]?.params).toEqual(["#t", "hello"]);
  });

  it("PART reason is clamped", () => {
    const { a, got } = pair();
    a.dispatch({ command: "PART", params: ["#t", long] });
    const relayed = got("v2", "PART")[0] as IrcMessage;
    expect(bytes(relayed)).toBeLessThanOrEqual(512);
    expect(relayed.params[1]?.length).toBeGreaterThan(0);
  });

  it("QUIT reason is clamped", () => {
    const { a, got } = pair();
    a.dispatch({ command: "QUIT", params: [long] });
    const relayed = got("v2", "QUIT")[0] as IrcMessage;
    expect(bytes(relayed)).toBeLessThanOrEqual(512);
  });

  it("KICK reason is cut to KICKLEN and fits", () => {
    const { a, got } = pair();
    a.dispatch({ command: "KICK", params: ["#t", "bob", "x".repeat(400)] });
    const relayed = got("v2", "KICK")[0] as IrcMessage;
    expect(relayed.params[2]).toHaveLength(300);
    expect(bytes(relayed)).toBeLessThanOrEqual(512);
  });

  it("TOPIC is stored and relayed at most TOPICLEN bytes", () => {
    const { a, server, got } = pair();
    a.dispatch({ command: "TOPIC", params: ["#t", "t".repeat(450)] });
    expect(server.ctx.channels.get("#t")?.topic).toHaveLength(300);
    const relayed = got("v2", "TOPIC")[0] as IrcMessage;
    expect(relayed.params[1]).toHaveLength(300);
    expect(bytes(relayed)).toBeLessThanOrEqual(512);
  });

  it("332 and 322 fit even when a stored topic is oversized", () => {
    const { b, server, got } = pair();
    const channel = server.ctx.channels.get("#t");
    if (channel === undefined) throw new Error("channel should exist");
    channel.topic = "é".repeat(400);
    b.dispatch({ command: "TOPIC", params: ["#t"] });
    b.dispatch({ command: "LIST", params: [] });
    for (const m of [...got("v2", "332"), ...got("v2", "322")]) {
      expect(bytes(m)).toBeLessThanOrEqual(512);
    }
    expect(got("v2", "332").length).toBe(1);
    expect(got("v2", "322").length).toBe(1);
  });

  it("005 advertises TOPICLEN, KICKLEN and AWAYLEN within 15 parameters", () => {
    const { got } = pair();
    const isupport = got("v1", "005")[0];
    expect(isupport?.params).toEqual(
      expect.arrayContaining(["TOPICLEN=300", "KICKLEN=300", "AWAYLEN=200"]),
    );
    expect(isupport?.params.length).toBeLessThanOrEqual(15);
  });

  it("clampBytes never splits a code point", () => {
    expect(clampBytes("a🎃b", 4)).toBe("a");
    expect(clampBytes("a🎃b", 5)).toBe("a🎃");
    expect(clampBytes("abc", 10)).toBe("abc");
  });

  it("clampTrailing fills the line exactly for ASCII", () => {
    const text = clampTrailing("p", "CMD", ["x"], "y".repeat(1000));
    expect(Buffer.byteLength(`:p CMD x :${text}\r\n`, "utf8")).toBe(512);
  });
});

describe("3. constant-time PASS", () => {
  it("safeEqual compares equal, different and different-length secrets", () => {
    expect(safeEqual("s3cret", "s3cret")).toBe(true);
    expect(safeEqual("s3cret", "s3creT")).toBe(false);
    expect(safeEqual("s3cret", "s")).toBe(false);
    expect(safeEqual("", "s3cret")).toBe(false);
  });

  it("registration accepts the right password and rejects a short wrong one", () => {
    const ok = virtualWorld({ IRCD_SERVER_PASSWORD: "s3cret" });
    const good = ok.server.createVirtualClient({ id: "g" });
    const goodMsgs: IrcMessage[] = [];
    good.onMessage((m) => goodMsgs.push(m));
    good.dispatch({ command: "PASS", params: ["s3cret"] });
    good.dispatch({ command: "NICK", params: ["good"] });
    good.dispatch({ command: "USER", params: ["good", "0", "*", "Good"] });
    expect(goodMsgs.some((m) => m.command === "001")).toBe(true);

    const bad = ok.server.createVirtualClient({ id: "b" });
    const badMsgs: IrcMessage[] = [];
    bad.onMessage((m) => badMsgs.push(m));
    bad.dispatch({ command: "PASS", params: ["s"] });
    bad.dispatch({ command: "NICK", params: ["bad"] });
    bad.dispatch({ command: "USER", params: ["bad", "0", "*", "Bad"] });
    expect(badMsgs.some((m) => m.command === "464")).toBe(true);
    expect(badMsgs.some((m) => m.command === "001")).toBe(false);
  });
});

describe("4. USER validation", () => {
  const attempt = (user: string, realname: string) => {
    const { server, inbox } = virtualWorld();
    const c = server.createVirtualClient({ id: "u" });
    const msgs: IrcMessage[] = [];
    inbox.set("u", msgs);
    c.onMessage((m) => msgs.push(m));
    c.dispatch({ command: "NICK", params: ["nick"] });
    c.dispatch({ command: "USER", params: [user, "0", "*", realname] });
    return { server, msgs };
  };

  it.each([
    ["bad!user", "Real"],
    ["a".repeat(19), "Real"],
    ["ü", "Real"],
    ["x", "x".repeat(51)],
    ["x", "bell\x07here"],
  ])("rejects user=%j realname=%j", (user, realname) => {
    const { server, msgs } = attempt(user, realname);
    const error = msgs.find((m) => m.command === "ERROR");
    expect(error?.params[0]).toMatch(/Invalid (username|realname)/);
    expect(msgs.some((m) => m.command === "001")).toBe(false);
    expect(server.ctx.connections.get("u")).toBeUndefined();
  });

  it("accepts a normal user and a 50-byte multi-byte real name", () => {
    const { msgs } = attempt("agent_1.x-y", "é".repeat(25));
    expect(msgs.some((m) => m.command === "001")).toBe(true);
  });

  it("validateUser reports the first problem", () => {
    expect(validateUser("ok", "Real Name")).toBeUndefined();
    expect(validateUser("", "r")).toBe("Invalid username");
    expect(validateUser("ok", "\u0000")).toBe("Invalid realname");
  });

  it("a registered client sending USER gets 462, not a validation close", () => {
    const { server, msgs } = attempt("ok", "Real");
    const c = server.ctx.connections.get("u") as VirtualClient;
    c.dispatch({ command: "USER", params: ["bad!", "0", "*", "Real"] });
    expect(msgs.some((m) => m.command === "462")).toBe(true);
    expect(server.ctx.connections.get("u")).toBeDefined();
  });
});

function fakeWire() {
  const state = { written: [] as string[], ended: 0, destroyed: 0, buffered: 0 };
  const wire: Wire = {
    write: (line) => {
      state.written.push(line);
    },
    end: () => {
      state.ended += 1;
    },
    destroy: () => {
      state.destroyed += 1;
    },
    bufferedBytes: () => state.buffered,
    isDestroyed: () => false,
  };
  return { wire, state };
}

function netSession(overrides: Partial<SessionLimits> = {}, env: Record<string, string> = {}) {
  const server: IrcServer = createServer(loadConfig(env), quiet);
  const { wire, state } = fakeWire();
  const session = new ConnectionSession(server.ctx, server.router, "n1", "203.0.113.9", wire, {
    ...DEFAULT_LIMITS,
    ...overrides,
  });
  return { server, session, state };
}

const register = (s: ConnectionSession, nick = "alice") =>
  s.receive(`NICK ${nick}\r\nUSER ${nick} 0 * :${nick}\r\n`);

describe("5. closing a network client is final", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("ends the wire, then destroys it after the grace period", () => {
    const { session, state } = netSession({ closeGraceMs: 2000 });
    session.client.close("bye");
    expect(state.written.at(-1)).toBe("ERROR :Closing Link: bye\r\n");
    expect(state.ended).toBe(1);
    expect(state.destroyed).toBe(0);
    vi.advanceTimersByTime(1999);
    expect(state.destroyed).toBe(0);
    vi.advanceTimersByTime(1);
    expect(state.destroyed).toBe(1);
  });

  it("does not destroy when the socket closes within the grace period", () => {
    const { session, state } = netSession({ closeGraceMs: 2000 });
    session.client.close("bye");
    session.closed();
    vi.advanceTimersByTime(10_000);
    expect(state.destroyed).toBe(0);
  });

  it("ignores input after close", () => {
    const { server, session, state } = netSession();
    session.client.close("bye");
    const before = state.written.length;
    session.receive("NICK mallory\r\nUSER m 0 * :m\r\n");
    expect(session.client.nick).toBeUndefined();
    expect(state.written).toHaveLength(before);
    expect(server.ctx.connections.isNickInUse("mallory")).toBe(false);
  });

  it("ignores the rest of a chunk after QUIT", () => {
    const { server, session } = netSession();
    session.receive("NICK a\r\nUSER a 0 * :a\r\nQUIT\r\nNICK b\r\n");
    expect(session.client.nick).toBe("a");
    expect(server.ctx.connections.get("n1")).toBeUndefined();
  });
});

describe("6. resource limits", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("TokenBucket allows a burst, refuses, then refills one token per interval", () => {
    let now = 0;
    const bucket = new TokenBucket(3, 1000, () => now);
    expect([bucket.tryTake(), bucket.tryTake(), bucket.tryTake(), bucket.tryTake()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    now = 999;
    expect(bucket.tryTake()).toBe(false);
    now = 1000;
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
    now = 100_000; // never exceeds capacity
    expect([bucket.tryTake(), bucket.tryTake(), bucket.tryTake(), bucket.tryTake()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });

  it("TokenBucket rejects bad parameters", () => {
    expect(() => new TokenBucket(0, 1000)).toThrow(/capacity/);
    expect(() => new TokenBucket(1, 0)).toThrow(/refillMs/);
  });

  it("flood: a burst beyond the bucket quits the client with Excess Flood", () => {
    const { server, session, state } = netSession({ floodBurst: 3, now: () => 0 });
    session.receive("PING a\r\nPING b\r\nPING c\r\nPING d\r\nPING e\r\n");
    expect(state.written.join("")).toContain("ERROR :Closing Link: Excess Flood");
    expect(state.ended).toBe(1);
    expect(server.ctx.connections.get("n1")).toBeUndefined();
    const pongs = state.written.filter((l) => l.includes("PONG"));
    expect(pongs).toHaveLength(3);
  });

  it("flood: normal traffic below the rate is never cut", () => {
    let now = 0;
    const { server, session } = netSession({ floodBurst: 2, floodRefillMs: 1000, now: () => now });
    for (let i = 0; i < 20; i++) {
      session.receive(`PING t${i}\r\n`);
      now += 1000;
    }
    expect(server.ctx.connections.get("n1")).toBeDefined();
  });

  it("virtual clients are exempt from flood control", () => {
    const { server, make } = virtualWorld({ IRCD_FLOOD_BURST: "1" });
    const a = make("v1", "agent");
    for (let i = 0; i < 50; i++) a.dispatch({ command: "PING", params: ["x"] });
    expect(server.ctx.connections.get("v1")).toBeDefined();
  });

  it("registration timeout quits a client that never registers", () => {
    const { server, state } = netSession({ registrationTimeoutMs: 60_000 });
    vi.advanceTimersByTime(59_999);
    expect(server.ctx.connections.get("n1")).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(state.written.join("")).toContain("Registration timeout");
    expect(server.ctx.connections.get("n1")).toBeUndefined();
  });

  it("registration timeout leaves a registered client alone", () => {
    const { server, session } = netSession({ registrationTimeoutMs: 1000 });
    register(session);
    vi.advanceTimersByTime(5000);
    expect(server.ctx.connections.get("n1")).toBeDefined();
  });

  it("registration timeout is cleared when the socket closes first", () => {
    const { session, state } = netSession({ registrationTimeoutMs: 1000 });
    session.closed();
    vi.advanceTimersByTime(5000);
    expect(state.written.join("")).not.toContain("Registration timeout");
  });

  it("write buffer cap: the client is dropped and destroyed, the line is not written", () => {
    const { server, session, state } = netSession({ maxWriteBufferBytes: 1000 });
    register(session);
    const before = state.written.length;
    state.buffered = 990;
    session.client.send({ command: "PING", params: ["server.example"] });
    expect(state.destroyed).toBe(1);
    expect(state.written).toHaveLength(before);
    expect(server.ctx.connections.get("n1")).toBeUndefined();
    expect(server.ctx.connections.isNickInUse("alice")).toBe(false);
  });

  it("write buffer cap notifies peers with a QUIT", () => {
    const { server, session, state } = netSession({ maxWriteBufferBytes: 1000 });
    const peer = server.createVirtualClient({ id: "v1" });
    const seen: IrcMessage[] = [];
    peer.onMessage((m) => seen.push(m));
    peer.dispatch({ command: "NICK", params: ["peer"] });
    peer.dispatch({ command: "USER", params: ["peer", "0", "*", "Peer"] });
    register(session);
    peer.dispatch({ command: "JOIN", params: ["#t"] });
    session.receive("JOIN #t\r\n");
    state.buffered = 5000;
    session.client.send({ command: "PING", params: ["x"] });
    expect(seen.some((m) => m.command === "QUIT" && m.params[0] === "SendQ exceeded")).toBe(true);
  });

  it("ConnectionGate refuses past the cap and frees slots on release", () => {
    const gate = new ConnectionGate(2);
    expect([gate.tryAcquire(), gate.tryAcquire(), gate.tryAcquire()]).toEqual([true, true, false]);
    gate.release();
    expect(gate.tryAcquire()).toBe(true);
    gate.release();
    gate.release();
    gate.release(); // extra release never goes negative
    expect(gate.count).toBe(0);
    expect(() => new ConnectionGate(0)).toThrow(/maxConnections/);
  });

  it("config reads the limits and rejects invalid values by name", () => {
    expect(
      loadConfig({
        IRCD_MAX_CONNECTIONS: "5",
        IRCD_FLOOD_BURST: "4",
        IRCD_FLOOD_REFILL_MS: "250",
        IRCD_REGISTRATION_TIMEOUT_MS: "9000",
        IRCD_MAX_WRITE_BUFFER_BYTES: "4096",
        IRCD_CLOSE_GRACE_MS: "10",
      }),
    ).toMatchObject({
      maxConnections: 5,
      floodBurst: 4,
      floodRefillMs: 250,
      registrationTimeoutMs: 9000,
      maxWriteBufferBytes: 4096,
      closeGraceMs: 10,
    });
    expect(loadConfig({})).toMatchObject({ maxConnections: 1000, floodBurst: 10, closeGraceMs: 2000 });
    for (const name of [
      "IRCD_MAX_CONNECTIONS",
      "IRCD_FLOOD_BURST",
      "IRCD_FLOOD_REFILL_MS",
      "IRCD_REGISTRATION_TIMEOUT_MS",
      "IRCD_MAX_WRITE_BUFFER_BYTES",
      "IRCD_CLOSE_GRACE_MS",
    ]) {
      expect(() => loadConfig({ [name]: "0" })).toThrow(name);
      expect(() => loadConfig({ [name]: "abc" })).toThrow(name);
    }
  });
});

describe("7. WebSocket origin allow-list", () => {
  it("parses a list, lower-cases and trims entries", () => {
    expect(parseAllowedOrigins(" HTTPS://Seance.Example , http://localhost:3000 ", "X")).toEqual([
      "https://seance.example",
      "http://localhost:3000",
    ]);
    expect(parseAllowedOrigins(undefined, "X")).toEqual([]);
    expect(parseAllowedOrigins("", "X")).toEqual([]);
  });

  it("rejects entries that are not origins", () => {
    for (const bad of ["seance.example", "https://a.example/path", "https://", "ftp"]) {
      expect(() => parseAllowedOrigins(bad, "IRCD_WS_ALLOWED_ORIGINS")).toThrow(
        /IRCD_WS_ALLOWED_ORIGINS/,
      );
    }
  });

  it("matches origins: absent is allowed, unlisted is not, * allows all", () => {
    const list = ["https://seance.example"];
    expect(isOriginAllowed(undefined, list)).toBe(true);
    expect(isOriginAllowed("", list)).toBe(true);
    expect(isOriginAllowed("https://SEANCE.example", list)).toBe(true);
    expect(isOriginAllowed("https://evil.example", list)).toBe(false);
    expect(isOriginAllowed("https://evil.example", [])).toBe(false);
    expect(isOriginAllowed("https://evil.example", ["*"])).toBe(true);
  });
});

describe("transports: origin and connection cap", () => {
  let server: IrcServer | undefined;
  const cleanups: (() => void)[] = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) c();
    await server?.stop();
    server = undefined;
  });

  async function start(env: Record<string, string>) {
    server = createServer(
      loadConfig({ IRCD_TCP_PORT: "0", IRCD_WS_PORT: "0", IRCD_HOST: "127.0.0.1", ...env }),
      quiet,
    );
    return server.start();
  }

  const open = (port: number, origin?: string): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, origin === undefined ? {} : { origin });
      cleanups.push(() => ws.terminate());
      ws.once("open", () => resolve(ws));
      ws.once("error", reject);
      ws.once("unexpected-response", (_req, res) =>
        reject(new Error(`HTTP ${res.statusCode ?? 0}`)),
      );
    });

  it("rejects a browser Origin by default with 403 and creates no client", async () => {
    const { wsPort } = await start({});
    await expect(open(wsPort, "https://evil.example")).rejects.toThrow(/403/);
    expect(server?.ctx.connections.size).toBe(0);
  });

  it("accepts a listed Origin and a connection without Origin", async () => {
    const { wsPort } = await start({ IRCD_WS_ALLOWED_ORIGINS: "https://seance.example" });
    await open(wsPort, "https://seance.example");
    await open(wsPort);
    await expect(open(wsPort, "https://evil.example")).rejects.toThrow(/403/);
  });

  it("refuses TCP connections beyond maxConnections and keeps no state for them", async () => {
    const { tcpPort } = await start({ IRCD_MAX_CONNECTIONS: "1" });
    const first = connect(tcpPort, "127.0.0.1");
    cleanups.push(() => first.destroy());
    await new Promise<void>((resolve) => first.once("connect", () => resolve()));
    for (let i = 0; i < 50 && server?.ctx.connections.size !== 1; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const second = connect(tcpPort, "127.0.0.1");
    cleanups.push(() => second.destroy());
    let received = "";
    second.setEncoding("utf8");
    second.on("data", (d: string) => (received += d));
    await new Promise<void>((resolve) => second.once("close", () => resolve()));
    expect(received).toBe("ERROR :Closing Link: Too many connections\r\n");
    expect(server?.ctx.connections.size).toBe(1);
  });

  it("refuses WebSocket connections beyond maxConnections with code 1013", async () => {
    const { wsPort } = await start({ IRCD_MAX_CONNECTIONS: "1" });
    await open(wsPort);
    const second = await open(wsPort);
    const code = await new Promise<number>((resolve) => second.once("close", (c) => resolve(c)));
    expect(code).toBe(1013);
    expect(server?.ctx.connections.size).toBe(1);
  });
});
