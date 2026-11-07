import type { IrcMessage } from "@seance/irc-protocol";
import { describe, expect, it } from "vitest";
import { initialState, reduce } from "./reducer.js";
import type { ClientState } from "./types.js";

const SRV = "ircd.test";
const msg = (command: string, ...params: string[]): IrcMessage => ({ prefix: SRV, command, params });

function run(start: ClientState, msgs: readonly IrcMessage[]): ClientState {
  return msgs.reduce((s, m) => reduce(s, m, 1000).state, start);
}

function registered(): ClientState {
  const s = { ...initialState("me"), phase: "registered" as const };
  const joined = reduce(s, { prefix: "me!u@h", command: "JOIN", params: ["#Chan"] }, 1).state;
  return joined;
}

const WHOIS = [
  msg("311", "me", "Coder", "coder", "host", "*", "Coder Agent"),
  msg("319", "me", "Coder", "@#chan"),
  msg("312", "me", "Coder", SRV, "Seance"),
  msg("320", "me", "Coder", "model: x"),
  msg("301", "me", "Coder", "brb"),
  msg("317", "me", "Coder", "12", "1700000000", "seconds idle, signon time"),
];

describe("WHOIS grouping", () => {
  it("emits one whois block in the Active_Window on 318, with away and 320 lines", () => {
    const s0 = registered();
    const mid = run(s0, [...WHOIS.slice(0, 3), { prefix: "bob!u@h", command: "PRIVMSG", params: ["#Chan", "hi"] }, ...WHOIS.slice(3)]);
    expect(mid.windows["c:#chan"]?.lines.filter((l) => l.kind === "whois")).toHaveLength(0);
    const s = run(mid, [msg("318", "me", "coder", "End of /WHOIS list")]);
    const blocks = (s.windows["c:#chan"]?.lines ?? []).filter((l) => l.kind === "whois");
    expect(blocks).toHaveLength(1);
    const w = blocks[0]?.whois;
    expect(w?.user).toEqual({ user: "coder", host: "host", realname: "Coder Agent" });
    expect(w?.channels).toEqual(["@#chan"]);
    expect(w?.server?.name).toBe(SRV);
    expect(w?.special).toEqual(["model: x"]);
    expect(w?.away).toBe("brb");
    expect(w?.idle).toEqual({ seconds: 12, signon: 1700000000 });
    expect(s.whoisPending).toEqual({});
  });

  it("keeps the 320 lines in received order as data for the line-based rendering", () => {
    const s = run(registered(), [
      msg("311", "me", "Coder", "coder", "host", "*", "Coder Agent"),
      msg("320", "me", "Coder", "model: x"),
      msg("320", "me", "Coder", "tools: shell"),
      msg("320", "me", "Coder", "credits: #dev 1.00 / total 2.00"),
      msg("318", "me", "coder", "End of /WHOIS list"),
    ]);
    const block = (s.windows["c:#chan"]?.lines ?? []).find((l) => l.kind === "whois");
    expect(block?.whois?.special).toEqual(["model: x", "tools: shell", "credits: #dev 1.00 / total 2.00"]);
    expect(block?.whois?.nick).toBe("Coder");
  });

  it("401 replaces the block with an error line and discards collected replies", () => {
    const s = run(registered(), [
      ...WHOIS.slice(0, 2),
      msg("401", "me", "Coder", "No such nick/channel"),
      msg("318", "me", "Coder", "End of /WHOIS list"),
    ]);
    const lines = s.windows["c:#chan"]?.lines ?? [];
    expect(lines.some((l) => l.kind === "whois")).toBe(false);
    expect(lines.at(-1)).toMatchObject({ kind: "error", text: "Coder No such nick/channel" });
    expect(s.whoisPending).toEqual({});
  });

  it("301 without a pending WHOIS is a plain line", () => {
    const s = run(registered(), [msg("301", "me", "bob", "gone")]);
    expect(s.windows["c:#chan"]?.lines.at(-1)?.text).toBe("bob is away: gone");
  });
});

describe("LIST, NAMES and error numerics", () => {
  it("routes 322/323 to the Status_Window", () => {
    const s = run(registered(), [msg("322", "me", "#a", "3", "topic here"), msg("323", "me", "End of /LIST")]);
    const lines = s.windows["status"]?.lines ?? [];
    expect(lines.map((l) => l.text)).toEqual(["#a 3 topic here", "End of /LIST"]);
  });

  it("prints a user-issued /names as one line in the Active_Window", () => {
    const base = registered();
    const s = run({ ...base, expectingNames: ["c:#chan"] }, [
      msg("353", "me", "=", "#Chan", "@me bob"),
      msg("366", "me", "#Chan", "End of /NAMES list"),
    ]);
    expect(s.windows["c:#chan"]?.lines.at(-1)?.text).toBe("Users on #Chan: @me bob");
    expect(s.expectingNames).toEqual([]);
  });

  it("shows 4xx/5xx as an error line in the Active_Window", () => {
    const s = run(registered(), [msg("482", "me", "#Chan", "You're not channel operator")]);
    expect(s.windows["c:#chan"]?.lines.at(-1)).toMatchObject({ kind: "error", text: "#Chan You're not channel operator" });
  });

  it("433 while registered shows an error line; while registering it sets no line", () => {
    const reg = run(registered(), [msg("433", "me", "x", "Nickname is already in use")]);
    expect(reg.windows["c:#chan"]?.lines.at(-1)?.kind).toBe("error");
    const pre: ClientState = { ...initialState("me"), phase: "registering" };
    for (const code of ["432", "433", "464"]) {
      const r = reduce(pre, msg(code, "*", "x", "nope"), 1).state;
      expect(r).toBe(pre);
    }
  });
});
