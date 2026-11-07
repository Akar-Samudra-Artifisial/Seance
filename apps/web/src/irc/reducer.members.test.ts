import type { IrcMessage } from "@seance/irc-protocol";
import { describe, expect, it } from "vitest";
import { initialState, reduce } from "./reducer.js";
import { addMember, applyModes, removeMember, renameMember } from "./reducer.members.js";
import type { ClientState } from "./types.js";

const m = (command: string, params: string[], prefix?: string): IrcMessage =>
  prefix === undefined ? { command, params } : { prefix, command, params };

function run(state: ClientState, ...msgs: IrcMessage[]): ClientState {
  return msgs.reduce((s, msg, i) => reduce(s, msg, 1000 + i).state, state);
}

const base = (): ClientState =>
  run(
    initialState("me"),
    m("001", ["me", "Welcome"], "irc.test"),
    m("JOIN", ["#Dev"], "me!u@h"),
    m("353", ["me", "=", "#Dev", "@me +Al[x] bob"], "irc.test"),
    m("JOIN", ["#Ops"], "me!u@h"),
    m("353", ["me", "=", "#Ops", "@me Al{x}"], "irc.test"),
  );

const nicks = (s: ClientState, key: string): string[] =>
  Object.values(s.windows[key]?.members ?? {})
    .map((x) => x.nick)
    .sort();

describe("member helpers", () => {
  it("addMember keeps an existing entry and never duplicates under rfc1459", () => {
    const a = addMember({}, "Al[x]");
    const b = addMember({ ...a, "al{x}": { nick: "Al{x}", op: true, voice: false } }, "al{x}");
    expect(Object.keys(b)).toEqual(["al{x}"]);
    expect(b["al{x}"]?.op).toBe(true);
  });

  it("renameMember keeps flags and collapses a collision to one entry", () => {
    const set = {
      a: { nick: "A", op: true, voice: false },
      b: { nick: "B", op: false, voice: true },
    };
    const r = renameMember(set, "A", "b");
    expect(Object.keys(r)).toEqual(["b"]);
    expect(r["b"]).toEqual({ nick: "b", op: true, voice: false });
  });

  it("removeMember and applyModes ignore non-members", () => {
    const set = { a: { nick: "A", op: false, voice: false } };
    expect(removeMember(set, "zed")).toBe(set);
    expect(applyModes(set, "+o", ["zed"])).toBe(set);
  });

  it("applyModes skips arguments of other modes", () => {
    const set = { a: { nick: "A", op: false, voice: false } };
    const r = applyModes(set, "+kov", ["secret", "A", "A"]);
    expect(r["a"]).toEqual({ nick: "A", op: true, voice: true });
    expect(applyModes(r, "-o+l", ["a", "5"])["a"]?.op).toBe(false);
  });
});

describe("reduce member operations", () => {
  it("PART of another user removes them from that channel only", () => {
    const s = run(base(), m("PART", ["#dev", "bye"], "BOB!u@h"));
    expect(nicks(s, "c:#dev")).toEqual(["Al[x]", "me"]);
    expect(s.windows["c:#dev"]?.lines.at(-1)?.kind).toBe("part");
  });

  it("own PART drops the window and keeps its lines", () => {
    const s = run(base(), m("PART", ["#Dev"], "me!u@h"));
    expect(s.windows["c:#dev"]).toBeUndefined();
    const active = run(base(), m("PART", ["#Ops"], "me!u@h"));
    expect(active.activeKey).toBe("status");
    expect(s.order).not.toContain("c:#dev");
    expect(s.closedLines["c:#dev"]?.length).toBeGreaterThan(0);
    expect(s.windows["c:#ops"]).toBeDefined();
  });

  it("own KICK closes the window; a KICK of another user removes only them", () => {
    const k = run(base(), m("KICK", ["#Dev", "bob", "no"], "me!u@h"));
    expect(nicks(k, "c:#dev")).toEqual(["Al[x]", "me"]);
    const own = run(base(), m("KICK", ["#Dev", "ME", "out"], "bob!u@h"));
    expect(own.windows["c:#dev"]).toBeUndefined();
    expect(own.closedLines["c:#dev"]?.at(-1)?.kind).toBe("kick");
  });

  it("closing a non-active window keeps the active key", () => {
    expect(base().activeKey).toBe("c:#ops");
    const s = run(base(), m("PART", ["#Dev"], "me!u@h"));
    expect(s.activeKey).toBe("c:#ops");
  });

  it("QUIT removes the user from every channel and logs a quit line with reason", () => {
    const s = run(base(), m("QUIT", ["gone"], "al{x}!u@h"));
    expect(nicks(s, "c:#dev")).toEqual(["bob", "me"]);
    expect(nicks(s, "c:#ops")).toEqual(["me"]);
    expect(s.windows["c:#ops"]?.lines.at(-1)?.text).toContain("gone");
  });

  it("NICK renames in every channel keeping flags, without duplicates", () => {
    const s = run(base(), m("NICK", ["Alex"], "AL{X}!u@h"));
    expect(nicks(s, "c:#dev")).toEqual(["Alex", "bob", "me"]);
    expect(nicks(s, "c:#ops")).toEqual(["Alex", "me"]);
    expect(s.windows["c:#dev"]?.members?.["alex"]?.voice).toBe(true);
  });

  it("NICK renames an open Query_Window and the own nick", () => {
    const q = run(base(), m("PRIVMSG", ["me", "hi"], "bob!u@h"));
    expect(q.windows["q:bob"]?.kind).toBe("query");
    const s = run(q, m("NICK", ["robert"], "bob!u@h"));
    expect(s.windows["q:bob"]).toBeUndefined();
    expect(s.windows["q:robert"]?.name).toBe("robert");
    expect(s.order).toContain("q:robert");
    const self = run(base(), m("NICK", ["me2"], "me!u@h"));
    expect(self.ownNick).toBe("me2");
    expect(self.windows["c:#dev"]?.members?.["me2"]?.op).toBe(true);
  });

  it("MODE sets and clears op/voice with rfc1459 case-mapping", () => {
    let s = run(base(), m("MODE", ["#Dev", "+o-v", "AL{X}", "al[x]"], "me!u@h"));
    expect(s.windows["c:#dev"]?.members?.["al{x}"]).toMatchObject({ op: true, voice: false });
    s = run(s, m("MODE", ["#Dev", "+v", "bob"], "me!u@h"));
    expect(s.windows["c:#dev"]?.members?.["bob"]?.voice).toBe(true);
    expect(s.windows["c:#dev"]?.lines.at(-1)?.kind).toBe("mode");
  });

  it("MODE for a non-member leaves the member set unchanged", () => {
    const before = base();
    const after = run(before, m("MODE", ["#Dev", "+o", "ghost"], "me!u@h"));
    expect(after.windows["c:#dev"]?.members).toEqual(before.windows["c:#dev"]?.members);
  });

  it("JOIN of an existing member keeps their flags", () => {
    const s = run(base(), m("JOIN", ["#Dev"], "AL[X]!u@h"));
    expect(s.windows["c:#dev"]?.members?.["al{x}"]?.voice).toBe(true);
    expect(nicks(s, "c:#dev")).toHaveLength(3);
  });
});
