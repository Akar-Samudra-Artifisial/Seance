import { parse } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { ConnectionSession } from "../src/network-client.js";
import type { Wire } from "../src/network-client.js";
import { createServer } from "../src/server.js";
import type { IrcServer } from "../src/server.js";

/** Common driver so tests can treat both client kinds the same way. */
interface Peer {
  readonly received: IrcMessage[];
  send(line: string): void;
}

function mustParse(line: string): IrcMessage {
  const result = parse(line);
  if (!("command" in result)) {
    throw new Error(`Test line did not parse: ${JSON.stringify(line)}`);
  }
  return result;
}

function newServer(): IrcServer {
  return createServer(loadConfig({}), { error: () => {} });
}

function networkPeer(server: IrcServer, id: string, nick: string): Peer {
  const received: IrcMessage[] = [];
  const wire: Wire = {
    write: (line) => {
      received.push(mustParse(line.replace(/\r?\n$/, "")));
    },
    end: () => {},
    destroy: () => {},
    bufferedBytes: () => 0,
    isDestroyed: () => false,
  };
  const session = new ConnectionSession(server.ctx, server.router, id, undefined, wire);
  const peer: Peer = { received, send: (line) => session.receive(`${line}\r\n`) };
  peer.send(`NICK ${nick}`);
  peer.send(`USER ${nick} 0 * :${nick}`);
  return peer;
}

function virtualPeer(server: IrcServer, id: string, nick: string): Peer {
  const received: IrcMessage[] = [];
  const client = server.createVirtualClient({ id });
  client.onMessage((m) => received.push(m));
  const peer: Peer = { received, send: (line) => void client.dispatch(mustParse(line)) };
  peer.send(`NICK ${nick}`);
  peer.send(`USER ${nick} 0 * :${nick}`);
  return peer;
}

/** Replace a nick with a placeholder so differently named peers can be compared. */
function normalize(msgs: readonly IrcMessage[], nick: string): unknown[] {
  const swap = (s: string): string => s.split(nick).join("<N>");
  return msgs.map((m) => ({
    ...(m.prefix !== undefined ? { prefix: swap(m.prefix) } : {}),
    command: m.command,
    params: m.params.map(swap),
  }));
}

/**
 * Run one scenario with the actor being either kind; return what the observer
 * (always a network client) saw after the actor registered.
 */
function observe(kind: "net" | "virtual", nick: string, actions: readonly string[]): unknown[] {
  const server = newServer();
  const observer = networkPeer(server, "obs", "obs");
  observer.send("JOIN #t");
  const actor =
    kind === "net" ? networkPeer(server, "act", nick) : virtualPeer(server, "act", nick);
  observer.received.length = 0;
  actor.send("JOIN #t");
  observer.send(`MODE #t +v ${nick}`);
  for (const a of actions) actor.send(a);
  return normalize(observer.received, nick);
}

describe("VirtualClient parity with network clients (Req 12.2, 12.3)", () => {
  it("broadcasts JOIN/MODE/PRIVMSG/NOTICE/PART/QUIT identically to peers", () => {
    const actions = [
      "PRIVMSG #t :hello world",
      "NOTICE #t :heads up",
      "PART #t :bye",
      "JOIN #t",
      "QUIT :gone",
    ];
    // Same-length nicks so any length-dependent formatting also matches.
    const net = observe("net", "agent", actions);
    const virt = observe("virtual", "agent", actions);
    expect(virt).toEqual(net);
    const commands = (virt as { command: string }[]).map((m) => m.command);
    expect(commands).toEqual(["JOIN", "MODE", "PRIVMSG", "NOTICE", "PART", "JOIN", "QUIT"]);
  });

  it("uses the nick!user@host prefix format for virtual client broadcasts", () => {
    const server = newServer();
    const observer = networkPeer(server, "obs", "obs");
    observer.send("JOIN #t");
    virtualPeer(server, "v", "agent").send("JOIN #t");
    const join = observer.received.find((m) => m.command === "JOIN" && m.prefix?.startsWith("agent!"));
    expect(join?.prefix).toBe(`agent!agent@${server.ctx.serverName}`);
  });

  it("shows @ and + prefixes in 353 for virtual clients just like network clients", () => {
    const run = (kind: "net" | "virtual"): string => {
      const server = newServer();
      const op = kind === "net" ? networkPeer(server, "a", "alice") : virtualPeer(server, "a", "alice");
      const voiced = kind === "net" ? networkPeer(server, "b", "bobby") : virtualPeer(server, "b", "bobby");
      const plain = networkPeer(server, "c", "carol");
      op.send("JOIN #t");
      voiced.send("JOIN #t");
      plain.send("JOIN #t");
      op.send("MODE #t +v bobby");
      plain.received.length = 0;
      plain.send("NAMES #t");
      const reply = plain.received.find((m) => m.command === "353");
      return reply?.params.at(-1) ?? "";
    };
    const net = run("net");
    expect(net.split(" ").sort()).toEqual(["+bobby", "@alice", "carol"]);
    expect(run("virtual")).toBe(net);
  });

  it("returns the same numerics as a network client for identical input and state", () => {
    const script = [
      "JOIN #t",
      "TOPIC #t :new topic",
      "PRIVMSG ghost :hello",
      "PRIVMSG #nope :hello",
      "PART #nope",
      "KICK #t ghost",
      "FROBNICATE",
      "LIST",
    ];
    // Kept short: network clients are flood-limited, virtual clients are not.
    const run = (kind: "net" | "virtual"): unknown[] => {
      const server = newServer();
      const peer =
        kind === "net" ? networkPeer(server, "x", "agent") : virtualPeer(server, "x", "agent");
      const after = peer.received.length;
      for (const line of script) peer.send(line);
      // Registration burst (001..005) is part of parity too, so compare everything.
      expect(after).toBeGreaterThan(0);
      return normalize(peer.received, "agent");
    };
    const net = run("net");
    const virt = run("virtual");
    expect(virt).toEqual(net);
    const numerics = (net as { command: string }[]).map((m) => m.command).filter((c) => /^\d{3}$/.test(c));
    expect(numerics).toEqual(expect.arrayContaining(["001", "353", "366", "401", "403"]));
  });

  it("rejects malformed and >512-byte (UTF-8) messages, reporting to the caller and routing nothing", () => {
    const server = newServer();
    const observer = networkPeer(server, "obs", "obs");
    observer.send("JOIN #t");
    const client = server.createVirtualClient({ id: "v" });
    client.dispatch({ command: "NICK", params: ["agent"] });
    client.dispatch({ command: "USER", params: ["agent", "0", "*", "agent"] });
    client.dispatch({ command: "JOIN", params: ["#t"] });
    observer.received.length = 0;

    // 200 three-byte characters: 200 chars, 600 UTF-8 bytes.
    const multibyte = "€".repeat(200);
    expect(multibyte.length).toBeLessThan(512);
    expect(() => client.dispatch({ command: "PRIVMSG", params: ["#t", multibyte] })).toThrow(/512/);
    // Embedded CR/LF would let one message smuggle a second command.
    expect(() =>
      client.dispatch({ command: "PRIVMSG", params: ["#t", "hi\r\nQUIT :x"] }),
    ).toThrow(/Rejected/);
    expect(() => client.dispatch({ command: "BAD CMD", params: [] })).toThrow(/Rejected/);
    expect(() =>
      client.dispatch({ command: "PRIVMSG", params: ["a b", "x"] }),
    ).toThrow(/Rejected/);

    expect(observer.received).toEqual([]);
    expect(server.ctx.connections.get("v")).toBeDefined();
  });
});
