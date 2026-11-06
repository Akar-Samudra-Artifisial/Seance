import type { IrcMessage } from "@seance/irc-protocol";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import type { VirtualClient } from "../src/virtual-client.js";

function setup() {
  const server = createServer(loadConfig({}), { error: () => {} });
  const inbox = new Map<string, IrcMessage[]>();
  const make = (id: string, nick: string): VirtualClient => {
    const client = server.createVirtualClient({ id });
    const msgs: IrcMessage[] = [];
    inbox.set(id, msgs);
    client.onMessage((m) => msgs.push(m));
    client.dispatch({ command: "NICK", params: [nick] });
    client.dispatch({ command: "USER", params: [nick, "0", "*", nick] });
    return client;
  };
  return { server, inbox, make };
}

describe("VirtualClient", () => {
  it("registers through the router and receives the welcome burst one message at a time", () => {
    const { inbox, make } = setup();
    make("v1", "agent");
    const commands = inbox.get("v1")?.map((m) => m.command) ?? [];
    expect(commands.slice(0, 5)).toEqual(["001", "002", "003", "004", "005"]);
  });

  it("routes commands with the same prefixes and @ marker as network clients", () => {
    const { inbox, make } = setup();
    const a = make("v1", "alice");
    const b = make("v2", "bob");
    a.dispatch({ command: "JOIN", params: ["#t"] });
    b.dispatch({ command: "JOIN", params: ["#t"] });
    const aMsgs = inbox.get("v1") ?? [];
    expect(aMsgs.some((m) => m.command === "JOIN" && m.prefix?.startsWith("bob!"))).toBe(true);
    const names = (inbox.get("v2") ?? []).find((m) => m.command === "353");
    expect(names?.params.at(-1)).toContain("@alice");
    b.dispatch({ command: "PRIVMSG", params: ["#t", "hi there"] });
    expect(aMsgs.find((m) => m.command === "PRIVMSG")).toMatchObject({
      params: ["#t", "hi there"],
    });
  });

  it("rejects overlong and malformed messages without routing them", () => {
    const { make } = setup();
    const a = make("v1", "alice");
    expect(() =>
      a.dispatch({ command: "PRIVMSG", params: ["#t", "x".repeat(600)] }),
    ).toThrow(/512/);
    expect(() => a.dispatch({ command: "BAD CMD", params: [] })).toThrow(/Rejected/);
  });

  it("stops delivering after unsubscribe and rejects dispatch after QUIT", () => {
    const { server, make } = setup();
    const a = make("v1", "alice");
    const seen: IrcMessage[] = [];
    const off = a.onMessage((m) => seen.push(m));
    off();
    a.dispatch({ command: "PING", params: ["x"] });
    expect(seen).toHaveLength(0);
    a.dispatch({ command: "QUIT", params: [] });
    expect(server.ctx.connections.get("v1")).toBeUndefined();
    expect(() => a.dispatch({ command: "PING", params: ["x"] })).toThrow(/closed/);
  });
});
