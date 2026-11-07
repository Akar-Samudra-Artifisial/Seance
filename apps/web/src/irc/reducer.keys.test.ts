import type { IrcMessage } from "@seance/irc-protocol";
import { describe, expect, it } from "vitest";
import { initialState, reduce } from "./reducer.js";
import { MAX_CLOSED, MAX_QUERIES, MAX_WHOIS_PENDING } from "./reducer.route.js";
import type { ClientState } from "./types.js";

const m = (command: string, params: string[], prefix?: string): IrcMessage =>
  prefix === undefined ? { command, params } : { prefix, command, params };

function run(state: ClientState, ...msgs: IrcMessage[]): ClientState {
  return msgs.reduce((s, msg, i) => reduce(s, msg, 1000 + i).state, state);
}

const registered = (): ClientState =>
  run({ ...initialState(), phase: "registering" }, m("001", ["me", "Welcome"], "irc.test"));
const joined = (): ClientState => run(registered(), m("JOIN", ["#dev"], "me!u@h"));

const PROTO_NICKS = ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"];

describe("prototype-named keys", () => {
  it.each(PROTO_NICKS)("PRIVMSG from nick %s opens a query window", (nick) => {
    const s = run(registered(), m("PRIVMSG", ["me", "hi"], `${nick}!u@h`));
    const key = `q:${nick.toLowerCase()}`;
    const win = Object.hasOwn(s.windows, key) ? s.windows[key] : undefined;
    expect(win?.kind).toBe("query");
    expect(win?.lines.at(-1)?.text).toBe("hi");
    expect(Object.getPrototypeOf(s.windows)).toBeNull();
  });

  it.each(PROTO_NICKS)("a channel PRIVMSG from nick %s and a JOIN by it work", (nick) => {
    const s = run(joined(), m("JOIN", ["#dev"], `${nick}!u@h`), m("PRIVMSG", ["#dev", "yo"], `${nick}!u@h`));
    const members = s.windows["c:#dev"]?.members ?? {};
    expect(Object.hasOwn(members, nick.toLowerCase())).toBe(true);
    expect(s.windows["c:#dev"]?.lines.at(-1)?.text).toBe("yo");
  });

  it("MODE +o on a non-member named toString changes nothing", () => {
    const before = joined();
    const after = run(before, m("MODE", ["#dev", "+o", "toString"], "me!u@h"));
    expect(Object.keys(after.windows["c:#dev"]?.members ?? {})).toEqual(Object.keys(before.windows["c:#dev"]?.members ?? {}));
    expect(Object.hasOwn(after.windows["c:#dev"]?.members ?? {}, "tostring")).toBe(false);
    expect(after.windows["c:#dev"]?.lines.at(-1)?.kind).toBe("mode");
  });

  it("MODE +o on a non-member named constructor does not throw or add a member", () => {
    const after = run(joined(), m("MODE", ["#dev", "+ov", "constructor", "__proto__"], "me!u@h"));
    expect(Object.keys(after.windows["c:#dev"]?.members ?? {})).toEqual([]);
    expect(after.windows["status"]?.lines.some((l) => l.kind === "error")).toBe(false);
  });

  it("WHOIS replies for nick constructor are collected and emitted", () => {
    const s = run(
      joined(),
      m("311", ["me", "constructor", "u", "h", "*", "Real"], "irc.test"),
      m("318", ["me", "constructor", "End"], "irc.test"),
    );
    expect(s.windows["c:#dev"]?.lines.some((l) => l.kind === "whois")).toBe(true);
    expect(Object.keys(s.whoisPending)).toEqual([]);
  });
});

describe("window key namespaces", () => {
  it("a query from a nick named Status does not write into the Status window", () => {
    const base = registered();
    const statusBefore = base.windows["status"]?.lines.length ?? 0;
    const s = run(base, m("PRIVMSG", ["me", "gotcha"], "Status!u@h"));
    expect(s.windows["status"]?.lines.length).toBe(statusBefore);
    expect(s.windows["status"]?.kind).toBe("status");
    expect(s.windows["q:status"]?.kind).toBe("query");
    expect(s.windows["q:status"]?.lines.at(-1)?.text).toBe("gotcha");
  });

  it("a nick change to Status does not replace or merge into the Status window", () => {
    const s = run(
      registered(),
      m("PRIVMSG", ["me", "hi"], "bob!u@h"),
      m("NICK", ["Status"], "bob!u@h"),
    );
    expect(s.windows["status"]?.kind).toBe("status");
    expect(s.windows["q:status"]?.name).toBe("Status");
  });
});

describe("bounds", () => {
  it(`opens at most ${MAX_QUERIES} query windows; further new nicks go to Status`, () => {
    const msgs: IrcMessage[] = [];
    for (let i = 0; i < MAX_QUERIES + 5; i++) msgs.push(m("PRIVMSG", ["me", `msg${i}`], `n${i}!u@h`));
    const s = run(registered(), ...msgs);
    const queries = Object.values(s.windows).filter((w) => w.kind === "query");
    expect(queries).toHaveLength(MAX_QUERIES);
    const statusTexts = s.windows["status"]?.lines.map((l) => l.text) ?? [];
    for (let i = MAX_QUERIES; i < MAX_QUERIES + 5; i++) expect(statusTexts).toContain(`msg${i}`);
    // An existing query still receives its lines.
    const again = run(s, m("PRIVMSG", ["me", "again"], "n0!u@h"));
    expect(again.windows["q:n0"]?.lines.at(-1)?.text).toBe("again");
  });

  it(`remembers at most ${MAX_CLOSED} closed windows`, () => {
    let s = registered();
    for (let i = 0; i < MAX_CLOSED + 10; i++) {
      s = run(s, m("JOIN", [`#c${i}`], "me!u@h"), m("PART", [`#c${i}`], "me!u@h"));
    }
    const keys = Object.keys(s.closedLines);
    expect(keys).toHaveLength(MAX_CLOSED);
    expect(keys).not.toContain("c:#c0");
    expect(keys).toContain(`c:#c${MAX_CLOSED + 9}`);
  });

  it(`keeps at most ${MAX_WHOIS_PENDING} pending WHOIS blocks`, () => {
    const msgs: IrcMessage[] = [];
    for (let i = 0; i < MAX_WHOIS_PENDING + 10; i++) msgs.push(m("311", ["me", `w${i}`, "u", "h", "*", "R"], "irc.test"));
    const s = run(registered(), ...msgs);
    const keys = Object.keys(s.whoisPending);
    expect(keys).toHaveLength(MAX_WHOIS_PENDING);
    expect(keys).not.toContain("w0");
    expect(keys).toContain(`w${MAX_WHOIS_PENDING + 9}`);
  });
});
