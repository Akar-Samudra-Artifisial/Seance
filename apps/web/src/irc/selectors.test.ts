import { describe, expect, it } from "vitest";
import { initialState } from "./reducer.js";
import { creditsTotal, exorcismText, modeSuffix, parseCreditsLine, statusCounts, titleOf } from "./selectors.js";
import { nullRecord } from "./record.js";
import type { ClientState, Member, Window } from "./types.js";

function member(nick: string, op = false): Member {
  return { nick, op, voice: false };
}

function channel(name: string, nicks: readonly Member[], extra: Partial<Window> = {}): Window {
  const members = nullRecord<Member>();
  for (const m of nicks) members[m.nick.toLowerCase()] = m;
  return {
    key: `c:${name}`,
    kind: "channel",
    name,
    lines: [],
    unread: false,
    mentioned: false,
    members,
    ...extra,
  };
}

function withWindows(wins: readonly Window[], activeKey: string, extra: Partial<ClientState> = {}): ClientState {
  const windows = nullRecord<Window>();
  for (const w of wins) windows[w.key] = w;
  const base = initialState("alice");
  return { ...base, windows: { ...base.windows, ...windows }, activeKey, ...extra };
}

describe("modeSuffix", () => {
  it("is empty for '' and '+'", () => {
    expect(modeSuffix("")).toBe("");
    expect(modeSuffix("+")).toBe("");
  });
  it("wraps flags", () => {
    expect(modeSuffix("+mnt")).toBe(" (+mnt)");
  });
});

describe("titleOf", () => {
  it("formats the status window", () => {
    const s = { ...initialState("alice"), userModes: "+iw" };
    expect(titleOf(s, "irc.example")).toBe("Séance — [Status: alice (+iw) on irc.example]");
    expect(titleOf({ ...s, userModes: "+" }, "h")).toBe("Séance — [Status: alice on h]");
  });
  it("formats channel with modes and topic", () => {
    const w = channel("#fix", [], { modes: "+mnt", topic: "Fix NPE" });
    expect(titleOf(withWindows([w], w.key), "h")).toBe("Séance — [#fix (+mnt): Fix NPE]");
  });
  it("omits empty modes and topic", () => {
    const w = channel("#fix", [], { modes: "+" });
    expect(titleOf(withWindows([w], w.key), "h")).toBe("Séance — [#fix]");
  });
  it("formats a query", () => {
    const w: Window = { key: "q:bob", kind: "query", name: "bob", lines: [], unread: false, mentioned: false };
    expect(titleOf(withWindows([w], w.key), "h")).toBe("Séance — [bob]");
  });
  it("strips control characters and IRC codes", () => {
    const w = channel("#fix", [], { topic: "\x02bold\x03" + "4red\x07 \u202eevil" });
    const t = titleOf(withWindows([w], w.key), "h");
    expect(t).toBe("Séance — [#fix: boldred evil]");
    expect(/[\x00-\x1f\x7f-\x9f]/.test(t)).toBe(false);
  });
});

describe("statusCounts", () => {
  const a = channel("#a", [member("coder", true), member("bob"), member("Carol")]);
  const b = channel("#b", [member("bob", true), member("reviewer")]);
  const state = withWindows([a, b], a.key, { away: Object.assign(nullRecord<string>(), { bob: "brb" }) });

  it("counts the active channel", () => {
    expect(statusCounts(state, "active")).toEqual({ agents: 1, away: 1, ops: 1, users: 3 });
  });
  it("counts distinct nicks over all channels", () => {
    expect(statusCounts(state, "all")).toEqual({ agents: 2, away: 1, ops: 2, users: 4 });
  });
  it("is zero for the status window and ignores exorcised nicks", () => {
    const x = channel("#x", [member("bob")], { exorcised: ["coder"] });
    expect(statusCounts(withWindows([x], "status"), "active")).toEqual({ agents: 0, away: 0, ops: 0, users: 0 });
    expect(statusCounts(withWindows([x], x.key), "active").agents).toBe(0);
  });
});

describe("creditsTotal", () => {
  it("sums the stored totals", () => {
    const credits = Object.assign(nullRecord<number>(), { coder: 25, reviewer: 10.5 });
    expect(creditsTotal({ ...initialState("a"), credits })).toBe(35.5);
    expect(creditsTotal(initialState("a"))).toBe(0);
  });
});

describe("parseCreditsLine re-export", () => {
  it("parses the runner form", () => {
    expect(parseCreditsLine("credits: #a 1.5 / total 25")).toEqual({ channel: "#a", used: 1.5, total: 25 });
    expect(parseCreditsLine("nope")).toBeUndefined();
  });
});

describe("exorcismText", () => {
  const base = { agent: "coder", kicker: "Alice" };
  it("keeps a real reason", () => {
    expect(exorcismText({ ...base, reason: "too slow" }).reason).toBe("too slow");
  });
  it("omits empty, invisible and control-only reasons", () => {
    for (const reason of ["", "   ", "\x02\x02", "\x0304"]) {
      expect(exorcismText({ ...base, reason }).reason).toBeUndefined();
    }
  });
  it("omits a reason equal to the kicker under rfc1459 case-mapping", () => {
    expect(exorcismText({ agent: "coder", kicker: "a[b", reason: "A{B" }).reason).toBeUndefined();
    expect(exorcismText({ ...base, reason: "alice" }).reason).toBeUndefined();
  });
});
