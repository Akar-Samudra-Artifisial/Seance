import { Numerics } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createRouter, createServer } from "../src/server.js";

describe("AWAY, WHOIS and INVITE wiring through createServer (Req 1.9, 2.10, 5.10)", () => {
  it("registers each command exactly once in createRouter", () => {
    const router = createRouter();
    for (const command of ["AWAY", "WHOIS", "INVITE"]) {
      expect(() => router.register(command, { minParams: 0, run: () => {} })).toThrow(
        /already exists/,
      );
    }
  });

  it("gates all three with 451 before registration, then serves them after", () => {
    const server = createServer(loadConfig({}), { error: () => {} });
    const received = new Map<string, IrcMessage[]>();
    const connect = (id: string) => {
      const client = server.createVirtualClient({ id });
      const msgs: IrcMessage[] = [];
      received.set(id, msgs);
      client.onMessage((m) => msgs.push(m));
      return { client, msgs };
    };
    const register = (client: ReturnType<typeof connect>["client"], nick: string): void => {
      client.dispatch({ command: "NICK", params: [nick] });
      client.dispatch({ command: "USER", params: [nick, "0", "*", nick] });
    };

    // Before registration every command is rejected with 451.
    const pre = connect("pre");
    pre.client.dispatch({ command: "AWAY", params: ["x"] });
    pre.client.dispatch({ command: "WHOIS", params: ["alice"] });
    pre.client.dispatch({ command: "INVITE", params: ["alice", "#room"] });
    expect(pre.msgs.map((m) => m.command)).toEqual([
      Numerics.ERR_NOTREGISTERED,
      Numerics.ERR_NOTREGISTERED,
      Numerics.ERR_NOTREGISTERED,
    ]);

    // After registration the real handlers answer.
    const alice = connect("a");
    const bob = connect("b");
    register(alice.client, "alice");
    register(bob.client, "bob");
    alice.client.dispatch({ command: "JOIN", params: ["#room"] });

    alice.msgs.length = 0;
    alice.client.dispatch({ command: "AWAY", params: ["gone"] });
    expect(alice.msgs.map((m) => m.command)).toEqual([Numerics.RPL_NOWAWAY]);

    bob.msgs.length = 0;
    bob.client.dispatch({ command: "WHOIS", params: ["alice"] });
    const whois = bob.msgs.map((m) => m.command);
    expect(whois).toContain(Numerics.RPL_WHOISUSER);
    expect(whois).toContain(Numerics.RPL_AWAY);
    expect(whois.at(-1)).toBe(Numerics.RPL_ENDOFWHOIS);

    alice.msgs.length = 0;
    bob.msgs.length = 0;
    alice.client.dispatch({ command: "INVITE", params: ["bob", "#room"] });
    expect(alice.msgs.map((m) => m.command)).toContain(Numerics.RPL_INVITING);
    expect(bob.msgs.map((m) => m.command)).toContain("INVITE");
  });
});
