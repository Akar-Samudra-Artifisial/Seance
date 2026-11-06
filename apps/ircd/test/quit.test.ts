import { describe, expect, it } from "vitest";
import type { IrcMessage } from "@seance/irc-protocol";
import { ChannelRegistry } from "../src/channel-registry.js";
import type { Client } from "../src/client.js";
import { CommandRouter } from "../src/command-router.js";
import type { RouterContext } from "../src/command-router.js";
import { ConnectionManager } from "../src/connection-manager.js";
import { registerJoinHandler } from "../src/handlers/join.js";
import { registerQuitHandler } from "../src/handlers/quit.js";

type TestClient = Client & { readonly sent: IrcMessage[]; readonly log: string[] };

function setup() {
  const channels = new ChannelRegistry();
  const connections = new ConnectionManager(channels.memberIdsLookup, { serverName: "irc.test" });
  const router = new CommandRouter();
  registerJoinHandler(router);
  registerQuitHandler(router);
  const ctx: RouterContext = {
    connections,
    channels,
    serverName: "irc.test",
    logger: { error: () => {} },
  };
  const add = (id: string, nick: string): TestClient => {
    const sent: IrcMessage[] = [];
    const log: string[] = [];
    const c: TestClient = {
      id,
      nick,
      user: nick,
      host: "host",
      registered: true,
      sent,
      log,
      send: (m) => {
        sent.push(m);
      },
      close: () => {
        // Record whether channels/nick were already handled at close time.
        log.push(
          `close:members=${channels.channelsOf(id).length}:nickInUse=${connections.isNickInUse(nick)}`,
        );
      },
    };
    connections.add(c);
    return c;
  };
  const run = (c: Client, command: string, ...params: string[]) =>
    router.dispatch(ctx, c, { command, params });
  return { ctx, channels, connections, add, run };
}

const quits = (c: TestClient) => c.sent.filter((m) => m.command === "QUIT");

describe("QUIT handler", () => {
  it("broadcasts the reason once per peer across shared channels, excluding the quitter", () => {
    const { add, run } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    run(alice, "JOIN", "#a,#b");
    run(bob, "JOIN", "#a,#b");
    run(alice, "QUIT", "bye now");
    expect(quits(bob)).toEqual([
      { prefix: "alice!alice@host", command: "QUIT", params: ["bye now"] },
    ]);
    expect(quits(alice)).toHaveLength(0);
  });

  it("uses 'Client Quit' without a reason", () => {
    const { add, run } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    run(alice, "JOIN", "#a");
    run(bob, "JOIN", "#a");
    run(alice, "QUIT");
    expect(quits(bob)[0]?.params).toEqual(["Client Quit"]);
  });

  it("removes from channels (deleting empty ones), closes, then releases the nick", () => {
    const { add, run, channels, connections } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    run(alice, "JOIN", "#solo,#shared");
    run(bob, "JOIN", "#shared");
    run(alice, "QUIT", "x");
    expect(channels.has("#solo")).toBe(false);
    expect(channels.get("#shared")?.members.has("1")).toBe(false);
    // At close: channels already removed, nick still held (released afterwards).
    expect(alice.log).toEqual(["close:members=0:nickInUse=true"]);
    expect(connections.isNickInUse("ALICE")).toBe(false);
    expect(connections.get("1")).toBeUndefined();
  });

  it("is idempotent when quit runs twice", () => {
    const { add, run } = setup();
    const alice = add("1", "alice");
    run(alice, "QUIT");
    run(alice, "QUIT");
    expect(alice.log).toHaveLength(1);
  });
});
