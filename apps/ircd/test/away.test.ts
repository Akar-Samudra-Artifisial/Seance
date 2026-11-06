import { Numerics } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import type { VirtualClient } from "../src/virtual-client.js";

function setup() {
  const server = createServer(loadConfig({}), { error: () => {} });
  const inbox = new Map<string, IrcMessage[]>();
  const create = (id: string): VirtualClient => {
    const client = server.createVirtualClient({ id });
    const msgs: IrcMessage[] = [];
    inbox.set(id, msgs);
    client.onMessage((m) => msgs.push(m));
    return client;
  };
  const register = (client: VirtualClient, nick: string): void => {
    client.dispatch({ command: "NICK", params: [nick] });
    client.dispatch({ command: "USER", params: [nick, "0", "*", nick] });
  };
  const make = (id: string, nick: string): VirtualClient => {
    const client = create(id);
    register(client, nick);
    return client;
  };
  const msgs = (id: string): IrcMessage[] => inbox.get(id) ?? [];
  const clear = (id: string): void => {
    msgs(id).length = 0;
  };
  return { make, create, register, msgs, clear };
}

const byteLen = (s: string): number => Buffer.byteLength(s, "utf8");

describe("AWAY command (Req 1.1-1.9)", () => {
  it("replies 306 when text is given and 305 when cleared", () => {
    const { make, msgs, clear } = setup();
    const a = make("v1", "alice");
    clear("v1");
    a.dispatch({ command: "AWAY", params: ["gone fishing"] });
    expect(msgs("v1").map((m) => m.command)).toEqual([Numerics.RPL_NOWAWAY]);
    clear("v1");
    a.dispatch({ command: "AWAY", params: [] });
    expect(msgs("v1").map((m) => m.command)).toEqual([Numerics.RPL_UNAWAY]);
    clear("v1");
    a.dispatch({ command: "AWAY", params: ["back"] });
    a.dispatch({ command: "AWAY", params: [""] });
    expect(msgs("v1").map((m) => m.command)).toEqual([
      Numerics.RPL_NOWAWAY,
      Numerics.RPL_UNAWAY,
    ]);
  });

  it("clamps stored text to 200 bytes on a multi-byte boundary", () => {
    const { make, msgs, clear } = setup();
    const a = make("v1", "alice");
    const b = make("v2", "bob");
    // "€" is 3 bytes: 100 of them = 300 bytes; 200 bytes would split a character.
    a.dispatch({ command: "AWAY", params: ["€".repeat(100)] });
    clear("v2");
    b.dispatch({ command: "PRIVMSG", params: ["alice", "hi"] });
    const reply = msgs("v2").find((m) => m.command === Numerics.RPL_AWAY);
    const text = reply?.params[2] ?? "";
    expect(text).toBe("€".repeat(66));
    expect(byteLen(text)).toBe(198);
    expect(text).not.toContain("\uFFFD");
  });

  it("advertises AWAYLEN=200 in 005", () => {
    const { make, msgs } = setup();
    make("v1", "alice");
    const tokens = msgs("v1")
      .filter((m) => m.command === Numerics.RPL_ISUPPORT)
      .flatMap((m) => m.params);
    expect(tokens).toContain("AWAYLEN=200");
  });

  it("sends exactly one 301 for PRIVMSG to an away nick, and delivers the message", () => {
    const { make, msgs, clear } = setup();
    const a = make("v1", "alice");
    const b = make("v2", "bob");
    a.dispatch({ command: "AWAY", params: ["lunch"] });
    clear("v1");
    clear("v2");
    b.dispatch({ command: "PRIVMSG", params: ["alice", "ping"] });
    const replies = msgs("v2").filter((m) => m.command === Numerics.RPL_AWAY);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.params).toEqual(["bob", "alice", "lunch"]);
    expect(msgs("v1").find((m) => m.command === "PRIVMSG")?.params).toEqual(["alice", "ping"]);
  });

  it("sends no 301 for NOTICE to an away nick", () => {
    const { make, msgs, clear } = setup();
    const a = make("v1", "alice");
    const b = make("v2", "bob");
    a.dispatch({ command: "AWAY", params: ["lunch"] });
    clear("v1");
    clear("v2");
    b.dispatch({ command: "NOTICE", params: ["alice", "ping"] });
    expect(msgs("v2").filter((m) => m.command === Numerics.RPL_AWAY)).toHaveLength(0);
    expect(msgs("v1").some((m) => m.command === "NOTICE")).toBe(true);
  });

  it("sends no 301 for PRIVMSG to a channel with an away member", () => {
    const { make, msgs, clear } = setup();
    const a = make("v1", "alice");
    const b = make("v2", "bob");
    a.dispatch({ command: "JOIN", params: ["#t"] });
    b.dispatch({ command: "JOIN", params: ["#t"] });
    a.dispatch({ command: "AWAY", params: ["lunch"] });
    clear("v1");
    clear("v2");
    b.dispatch({ command: "PRIVMSG", params: ["#t", "hello"] });
    expect(msgs("v2").filter((m) => m.command === Numerics.RPL_AWAY)).toHaveLength(0);
    expect(msgs("v1").some((m) => m.command === "PRIVMSG")).toBe(true);
  });

  it("stops sending 301 once the target clears AWAY", () => {
    const { make, msgs, clear } = setup();
    const a = make("v1", "alice");
    const b = make("v2", "bob");
    a.dispatch({ command: "AWAY", params: ["lunch"] });
    a.dispatch({ command: "AWAY", params: [] });
    clear("v2");
    b.dispatch({ command: "PRIVMSG", params: ["alice", "ping"] });
    expect(msgs("v2").filter((m) => m.command === Numerics.RPL_AWAY)).toHaveLength(0);
  });

  it("replies 451 to an unregistered AWAY and leaves away state untouched", () => {
    const { make, create, register, msgs, clear } = setup();
    const c = create("v1");
    c.setAway("original");
    c.dispatch({ command: "AWAY", params: ["changed"] });
    const codes = msgs("v1").map((m) => m.command);
    expect(codes).toContain(Numerics.ERR_NOTREGISTERED);
    expect(codes).not.toContain(Numerics.RPL_NOWAWAY);
    expect(codes).not.toContain(Numerics.RPL_UNAWAY);

    c.dispatch({ command: "AWAY", params: [] });
    expect(msgs("v1").map((m) => m.command)).not.toContain(Numerics.RPL_UNAWAY);

    register(c, "carol");
    const b = make("v2", "bob");
    clear("v2");
    b.dispatch({ command: "PRIVMSG", params: ["carol", "ping"] });
    const reply = msgs("v2").find((m) => m.command === Numerics.RPL_AWAY);
    expect(reply?.params[2]).toBe("original");
  });
});

describe("VirtualClient.setAway (Req 1.7, 1.8)", () => {
  it("clamps to 200 bytes at a code point boundary without a wire reply", () => {
    const { make, msgs, clear } = setup();
    const a = make("v1", "alice");
    const b = make("v2", "bob");
    clear("v1");
    a.setAway("€".repeat(100));
    expect(msgs("v1")).toEqual([]);
    clear("v2");
    b.dispatch({ command: "PRIVMSG", params: ["alice", "hi"] });
    const text = msgs("v2").find((m) => m.command === Numerics.RPL_AWAY)?.params[2] ?? "";
    expect(byteLen(text)).toBeLessThanOrEqual(200);
    expect(text).toBe("€".repeat(66));
  });

  it("clears on undefined or empty text", () => {
    const { make, msgs, clear } = setup();
    const a = make("v1", "alice");
    const b = make("v2", "bob");
    for (const clearing of [undefined, ""]) {
      a.setAway("busy");
      a.setAway(clearing);
      clear("v2");
      b.dispatch({ command: "PRIVMSG", params: ["alice", "hi"] });
      expect(msgs("v2").filter((m) => m.command === Numerics.RPL_AWAY)).toHaveLength(0);
    }
  });
});
