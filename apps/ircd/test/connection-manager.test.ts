import { describe, expect, it } from "vitest";
import type { IrcMessage } from "@seance/irc-protocol";
import type { Client } from "../src/client.js";
import { ConnectionManager } from "../src/connection-manager.js";

function makeClient(id: string): Client & { readonly sent: IrcMessage[] } {
  const sent: IrcMessage[] = [];
  return {
    id,
    registered: false,
    sent,
    send: (msg) => {
      sent.push(msg);
    },
    close: () => {},
  };
}

const msg: IrcMessage = { prefix: "a!u@h", command: "QUIT", params: ["Client Quit"] };

describe("ConnectionManager nick index", () => {
  it("finds clients by id and by rfc1459 case-mapped nick", () => {
    const cm = new ConnectionManager(() => []);
    const a = makeClient("1");
    cm.add(a);
    expect(cm.setNick(a, "Nick[a]")).toBe("ok");
    expect(cm.get("1")).toBe(a);
    expect(cm.getByNick("nick{A}")).toBe(a);
  });

  it("rejects a nick owned by another client under case-mapping", () => {
    const cm = new ConnectionManager(() => []);
    const a = makeClient("1");
    const b = makeClient("2");
    cm.add(a);
    cm.add(b);
    cm.setNick(a, "Foo[]");
    expect(cm.setNick(b, "foo{}")).toBe("in-use");
    expect(b.nick).toBeUndefined();
  });

  it("allows a case-only change of the client's own nick and frees the old key", () => {
    const cm = new ConnectionManager(() => []);
    const a = makeClient("1");
    cm.add(a);
    cm.setNick(a, "bob");
    expect(cm.setNick(a, "Bob")).toBe("ok");
    expect(a.nick).toBe("Bob");
    cm.setNick(a, "carol");
    expect(cm.isNickInUse("bob")).toBe(false);
  });

  it("releases the nick on removal so it is reusable", () => {
    const cm = new ConnectionManager(() => []);
    const a = makeClient("1");
    const b = makeClient("2");
    cm.add(a);
    cm.add(b);
    cm.setNick(a, "Dave\\");
    expect(cm.remove("1")).toBe(true);
    expect(cm.get("1")).toBeUndefined();
    expect(cm.setNick(b, "dave|")).toBe("ok");
    expect(cm.remove("1")).toBe(false);
  });

  it("rejects duplicate client ids", () => {
    const cm = new ConnectionManager(() => []);
    cm.add(makeClient("1"));
    expect(() => cm.add(makeClient("1"))).toThrow(/already tracked/);
  });
});

describe("ConnectionManager registration", () => {
  it("registers only after NICK and USER, exactly once", () => {
    const cm = new ConnectionManager(() => []);
    const a = makeClient("1");
    cm.add(a);
    cm.setNick(a, "al");
    expect(cm.tryCompleteRegistration(a)).toBe(false);
    expect(cm.setUser(a, "alice")).toBe("ok");
    expect(cm.tryCompleteRegistration(a)).toBe(true);
    expect(a.registered).toBe(true);
    expect(cm.tryCompleteRegistration(a)).toBe(false);
  });

  it("requires PASS when asked", () => {
    const cm = new ConnectionManager(() => []);
    const a = makeClient("1");
    cm.add(a);
    cm.setNick(a, "al");
    cm.setUser(a, "alice");
    expect(cm.tryCompleteRegistration(a, true)).toBe(false);
    expect(cm.acceptPass(a)).toBe("ok");
    expect(cm.tryCompleteRegistration(a, true)).toBe(true);
  });

  it("reports already-registered for PASS/USER after registration and keeps state", () => {
    const cm = new ConnectionManager(() => []);
    const a = makeClient("1");
    cm.add(a);
    cm.setNick(a, "al");
    cm.setUser(a, "alice");
    cm.tryCompleteRegistration(a);
    expect(cm.acceptPass(a)).toBe("already-registered");
    expect(cm.setUser(a, "other")).toBe("already-registered");
    expect(a.user).toBe("alice");
  });
});

describe("ConnectionManager.broadcastToPeers", () => {
  it("sends once per peer sharing channels and excludes the subject", () => {
    const a = makeClient("a");
    const b = makeClient("b");
    const c = makeClient("c");
    const d = makeClient("d");
    const channels: Record<string, string[][]> = {
      a: [["a", "b", "c"], ["a", "b"]],
    };
    const cm = new ConnectionManager((id) => channels[id] ?? []);
    for (const x of [a, b, c, d]) cm.add(x);

    cm.broadcastToPeers(a, msg);
    expect(a.sent).toHaveLength(0);
    expect(b.sent).toEqual([msg]);
    expect(c.sent).toEqual([msg]);
    expect(d.sent).toHaveLength(0);
  });

  it("includes the subject once when asked, even with no channels", () => {
    const a = makeClient("a");
    const cm = new ConnectionManager(() => []);
    cm.add(a);
    cm.broadcastToPeers(a, msg, { includeSelf: true });
    expect(a.sent).toEqual([msg]);
  });

  it("keeps delivering after one peer fails, then reports the failure", () => {
    const a = makeClient("a");
    const b = makeClient("b");
    const c = makeClient("c");
    const failing: Client = {
      ...b,
      send: () => {
        throw new Error("socket closed");
      },
    };
    const cm = new ConnectionManager(() => [["a", "b", "c"]]);
    cm.add(a);
    cm.add(failing);
    cm.add(c);
    expect(() => cm.broadcastToPeers(a, msg)).toThrow(AggregateError);
    expect(c.sent).toEqual([msg]);
  });
});
