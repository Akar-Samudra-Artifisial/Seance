import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IrcMessage } from "@seance/irc-protocol";
import { ChannelRegistry } from "../src/channel-registry.js";
import type { Client } from "../src/client.js";
import { CommandRouter } from "../src/command-router.js";
import type { RouterContext } from "../src/command-router.js";
import { ConnectionManager } from "../src/connection-manager.js";
import { registerKeepAliveHandlers } from "../src/handlers/keepalive.js";

const IDLE = 1000;
const TIMEOUT = 500;

function makeClient(id: string): Client & { readonly sent: IrcMessage[]; closed: string[] } {
  const sent: IrcMessage[] = [];
  const closed: string[] = [];
  return {
    id,
    registered: true,
    nick: "alice",
    sent,
    closed,
    send: (m) => {
      sent.push(m);
    },
    close: (reason) => {
      closed.push(reason);
    },
  };
}

function setup() {
  const channels = new ChannelRegistry();
  const connections = new ConnectionManager(channels.memberIdsLookup, {
    serverName: "irc.test",
    idleIntervalMs: IDLE,
    pingTimeoutMs: TIMEOUT,
  });
  const router = new CommandRouter();
  registerKeepAliveHandlers(router);
  const ctx: RouterContext = {
    connections,
    channels,
    serverName: "irc.test",
    logger: { error: () => {} },
  };
  const client = makeClient("1");
  connections.add(client);
  return { connections, router, ctx, client };
}

describe("PING / PONG handlers (Req 4.1, 4.2)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("replies PONG <server> :<token>", () => {
    const { router, ctx, client } = setup();
    router.dispatch(ctx, client, { command: "PING", params: ["hello world"] });
    expect(client.sent).toEqual([
      { prefix: "irc.test", command: "PONG", params: ["irc.test", "hello world"] },
    ]);
  });

  it("replies 461 to PING without a token", () => {
    const { router, ctx, client } = setup();
    expect(router.dispatch(ctx, client, { command: "PING", params: [] })).toBe("need-more-params");
    expect(client.sent[0]?.command).toBe("461");
  });
});

describe("keep-alive timers (Req 4.3, 4.4)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends PING after the idle interval", () => {
    const { client } = setup();
    vi.advanceTimersByTime(IDLE - 1);
    expect(client.sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(client.sent).toEqual([{ command: "PING", params: ["irc.test"] }]);
  });

  it("any complete message resets the idle timer", () => {
    const { router, ctx, client } = setup();
    vi.advanceTimersByTime(IDLE - 1);
    router.dispatch(ctx, client, { command: "PONG", params: [] });
    vi.advanceTimersByTime(IDLE - 1);
    expect(client.sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(client.sent).toHaveLength(1);
  });

  it("closes with 'Ping timeout' when unanswered", () => {
    const { client } = setup();
    vi.advanceTimersByTime(IDLE + TIMEOUT - 1);
    expect(client.closed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(client.closed).toEqual(["Ping timeout"]);
  });

  it("does not close when the client answers in time", () => {
    const { router, ctx, client } = setup();
    vi.advanceTimersByTime(IDLE + TIMEOUT - 1);
    router.dispatch(ctx, client, { command: "PONG", params: ["irc.test"] });
    vi.advanceTimersByTime(TIMEOUT * 2);
    expect(client.closed).toEqual([]);
  });

  it("clears timers when the client is removed", () => {
    const { connections, client } = setup();
    connections.remove(client.id);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(IDLE + TIMEOUT);
    expect(client.sent).toEqual([]);
    expect(client.closed).toEqual([]);
  });
});
