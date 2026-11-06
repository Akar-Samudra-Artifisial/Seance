import { Numerics } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

// Feature: ircd-agent-commands-fixes, Findings 4 (exploration): INVITE event fields and 301.
// Requirements 1.9, 1.10. Written before the fix.

function setup(claims: ReadonlySet<string> = new Set()) {
  const server = createServer(
    loadConfig({}),
    { error: () => {} },
    { inviteResolver: (target) => claims.has(target) },
  );
  const events: Array<Record<string, unknown>> = [];
  server.events.subscribe("irc.invite", (e) => events.push({ ...e }));
  const inbox = new Map<string, IrcMessage[]>();
  const make = (id: string, nick: string) => {
    const client = server.createVirtualClient({ id });
    const msgs: IrcMessage[] = [];
    inbox.set(id, msgs);
    client.onMessage((m) => msgs.push(m));
    client.dispatch({ command: "NICK", params: [nick] });
    // USER only accepts [A-Za-z0-9._~-]; nicks such as `A[B` need a safe username.
    const user = nick.replace(/[^A-Za-z0-9._~-]/g, "x");
    client.dispatch({ command: "USER", params: [user, "0", "*", nick] });
    return client;
  };
  const alice = make("a", "alice");
  alice.dispatch({ command: "JOIN", params: ["#t"] });
  const clear = (): void => {
    for (const m of inbox.values()) m.length = 0;
  };
  clear();
  return { server, alice, make, events, inbox, clear };
}

describe("Finding 4: INVITE event fields and 301 (exploration)", () => {
  it("1.9 event for a connected target carries targetKey and targetOnline=true", () => {
    const { alice, make, events } = setup();
    make("b", "Bob");
    alice.dispatch({ command: "INVITE", params: ["bob", "#t"] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ channel: "#t", inviter: "alice", target: "Bob" });
    expect(events[0]?.["targetKey"]).toBe("bob");
    expect(events[0]?.["targetOnline"]).toBe(true);
  });

  it("1.9 targetKey uses rfc1459 case-mapping", () => {
    const { alice, make, events } = setup();
    make("b", "A[B");
    alice.dispatch({ command: "INVITE", params: ["A[B", "#t"] });
    expect(events).toHaveLength(1);
    expect(events[0]?.["targetKey"]).toBe("a{b");
  });

  it("1.9 event for a resolver claim has targetOnline=false", () => {
    const { alice, events } = setup(new Set(["Ghost"]));
    alice.dispatch({ command: "INVITE", params: ["Ghost", "#t"] });
    expect(events).toHaveLength(1);
    expect(events[0]?.["targetKey"]).toBe("ghost");
    expect(events[0]?.["targetOnline"]).toBe(false);
  });

  // One test per requirement: the away case reproduces the bug; the non-away and
  // resolver-claim cases (which already hold) are soft checks in the same test so the
  // whole 1.10 rule is pinned without a test that passes on unfixed code.
  it("1.10 301 follows 341 only for an away connected target", () => {
    const awayCase = setup();
    const bob = awayCase.make("b", "bob");
    bob.setAway("gone fishing");
    awayCase.clear();
    awayCase.alice.dispatch({ command: "INVITE", params: ["bob", "#t"] });
    const replies = awayCase.inbox.get("a") ?? [];
    expect.soft(replies.map((m) => m.command), "away target").toEqual([
      Numerics.RPL_INVITING,
      Numerics.RPL_AWAY,
    ]);
    const away = replies.find((m) => m.command === Numerics.RPL_AWAY);
    expect.soft(away?.params, "301 params").toEqual(["alice", "bob", "gone fishing"]);

    const plain = setup();
    plain.make("b", "bob");
    plain.clear();
    plain.alice.dispatch({ command: "INVITE", params: ["bob", "#t"] });
    expect
      .soft((plain.inbox.get("a") ?? []).map((m) => m.command), "non-away target")
      .toEqual([Numerics.RPL_INVITING]);

    const claim = setup(new Set(["ghost"]));
    claim.clear();
    claim.alice.dispatch({ command: "INVITE", params: ["ghost", "#t"] });
    expect
      .soft((claim.inbox.get("a") ?? []).map((m) => m.command), "resolver claim")
      .toEqual([Numerics.RPL_INVITING]);
  });
});
