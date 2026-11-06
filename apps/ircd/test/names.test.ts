import { describe, expect, it } from "vitest";
import { serialize } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import { ChannelRegistry } from "../src/channel-registry.js";
import type { Client } from "../src/client.js";
import { CommandRouter } from "../src/command-router.js";
import type { RouterContext } from "../src/command-router.js";
import { ConnectionManager } from "../src/connection-manager.js";
import { registerJoinHandler } from "../src/handlers/join.js";
import { registerNamesHandler } from "../src/handlers/names.js";

type TestClient = Client & { readonly sent: IrcMessage[] };

function makeClient(id: string, nick: string): TestClient {
  const sent: IrcMessage[] = [];
  return {
    id,
    nick,
    user: nick,
    host: "host",
    registered: true,
    sent,
    send: (m) => {
      sent.push(m);
    },
    close: () => {},
  };
}

function setup() {
  const channels = new ChannelRegistry();
  const connections = new ConnectionManager(channels.memberIdsLookup, {
    serverName: "irc.test",
  });
  const router = new CommandRouter();
  registerJoinHandler(router);
  registerNamesHandler(router);
  const ctx: RouterContext = {
    connections,
    channels,
    serverName: "irc.test",
    logger: { error: () => {} },
  };
  const add = (id: string, nick: string): TestClient => {
    const c = makeClient(id, nick);
    connections.add(c);
    return c;
  };
  const join = (c: Client, arg: string) =>
    router.dispatch(ctx, c, { command: "JOIN", params: [arg] });
  const names = (c: Client, ...params: string[]) =>
    router.dispatch(ctx, c, { command: "NAMES", params });
  return { ctx, channels, add, join, names };
}

const end = (nick: string, name: string): IrcMessage => ({
  prefix: "irc.test",
  command: "366",
  params: [nick, name, "End of /NAMES list"],
});

describe("NAMES handler", () => {
  it("prefixes ops with @, voiced with + and plain members with nothing", () => {
    const { add, join, names, channels } = setup();
    const alice = add("1", "alice");
    const bob = add("2", "bob");
    const carol = add("3", "carol");
    join(alice, "#test");
    join(bob, "#test");
    join(carol, "#test");
    const members = channels.get("#test")?.members;
    const bobEntry = members?.get("2");
    if (bobEntry === undefined) throw new Error("bob should be a member");
    bobEntry.voice = true;
    alice.sent.length = 0;
    names(alice, "#test");
    expect(alice.sent).toEqual([
      { prefix: "irc.test", command: "353", params: ["alice", "=", "#test", "@alice +bob carol"] },
      end("alice", "#test"),
    ]);
  });

  it("matches the channel name case-insensitively and reports the canonical name", () => {
    const { add, join, names } = setup();
    const alice = add("1", "alice");
    join(alice, "#Test");
    alice.sent.length = 0;
    names(alice, "#TEST");
    expect(alice.sent[0]?.params).toEqual(["alice", "=", "#Test", "@alice"]);
    expect(alice.sent[1]).toEqual(end("alice", "#Test"));
  });

  it("replies only 366 for a missing channel", () => {
    const { add, names } = setup();
    const alice = add("1", "alice");
    names(alice, "#nope");
    expect(alice.sent).toEqual([end("alice", "#nope")]);
  });

  it("processes a comma list in order", () => {
    const { add, join, names } = setup();
    const alice = add("1", "alice");
    join(alice, "#a");
    join(alice, "#b");
    alice.sent.length = 0;
    names(alice, "#b,#missing,#a");
    expect(alice.sent.map((m) => `${m.command} ${m.params[m.command === "353" ? 2 : 1]}`)).toEqual([
      "353 #b",
      "366 #b",
      "366 #missing",
      "353 #a",
      "366 #a",
    ]);
  });

  it("splits long lists across 353 lines within 512 bytes using multi-byte nicks", () => {
    const { add, join, names } = setup();
    const observer = add("0", "observer");
    join(observer, "#big");
    const nicks = ["observer"];
    for (let i = 1; i <= 60; i++) {
      const nick = `nïck${"é".repeat(10)}${i}`;
      nicks.push(nick);
      join(add(String(i), nick), "#big");
    }
    observer.sent.length = 0;
    names(observer, "#big");

    const lines = observer.sent;
    const replies = lines.filter((m) => m.command === "353");
    expect(replies.length).toBeGreaterThan(1);
    for (const m of lines) {
      expect(Buffer.byteLength(serialize(m), "utf8")).toBeLessThanOrEqual(512);
    }
    const listed = replies
      .flatMap((m) => (m.params[3] ?? "").split(" "))
      .map((n) => n.replace(/^[@+]/, ""));
    expect([...listed].sort()).toEqual([...nicks].sort());
    expect(lines.filter((m) => m.command === "366")).toEqual([end("observer", "#big")]);
    expect(lines[lines.length - 1]?.command).toBe("366");
  });

  it("sends a bare 366 for * when no parameter is given", () => {
    const { add, names } = setup();
    const alice = add("1", "alice");
    expect(names(alice)).toBe("handled");
    expect(alice.sent).toEqual([end("alice", "*")]);
  });
});
