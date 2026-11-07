import type { IrcMessage } from "@seance/irc-protocol";
import { describe, expect, it } from "vitest";
import { initialState, reduce } from "./reducer.js";
import type { ClientState } from "./types.js";

const m = (command: string, params: string[], prefix?: string): IrcMessage =>
  prefix === undefined ? { command, params } : { prefix, command, params };

function run(state: ClientState, ...msgs: IrcMessage[]): ClientState {
  return msgs.reduce((s, msg, i) => reduce(s, msg, 1000 + i).state, state);
}

const registered = (): ClientState =>
  run({ ...initialState(), phase: "registering" }, m("001", ["me", "Welcome"], "irc.test"));
const joined = (): ClientState => run(registered(), m("JOIN", ["#Dev"], "me!u@h"));

describe("reduce", () => {
  it("001 registers and writes to the status window", () => {
    const s = registered();
    expect(s.phase).toBe("registered");
    expect(s.ownNick).toBe("me");
    expect(s.windows["status"]?.lines.map((l) => l.text).slice(1)).toEqual(["Welcome"]);
  });

  it("routes 002-005, MOTD and server NOTICE to status", () => {
    const s = run(
      registered(),
      m("002", ["me", "Your host"], "irc.test"),
      m("375", ["me", "- MOTD -"], "irc.test"),
      m("372", ["me", "- Server is haunted"], "irc.test"),
      m("NOTICE", ["me", "hello"], "irc.test"),
    );
    expect(s.windows["status"]?.lines.map((l) => l.kind)).toEqual(["system", "numeric", "numeric", "motd", "motd", "notice"]);
  });

  it("own JOIN opens and activates the channel window", () => {
    const s = joined();
    expect(s.activeKey).toBe("c:#dev");
    expect(s.order).toEqual(["status", "c:#dev"]);
    expect(s.windows["c:#dev"]?.name).toBe("#Dev");
    expect(s.windows["c:#dev"]?.members).toEqual({});
  });

  it("other JOIN adds a member", () => {
    const s = run(joined(), m("JOIN", ["#dev"], "Coder!c@h"));
    expect(s.windows["c:#dev"]?.members?.["coder"]).toEqual({ nick: "Coder", op: false, voice: false });
  });

  it("353/366 parse @ and + prefixes", () => {
    const s = run(
      joined(),
      m("353", ["me", "=", "#dev", "@me +coder reviewer"], "irc.test"),
      m("366", ["me", "#dev", "End"], "irc.test"),
    );
    const members = s.windows["c:#dev"]?.members;
    expect(members?.["me"]?.op).toBe(true);
    expect(members?.["coder"]).toEqual({ nick: "coder", op: false, voice: true });
    expect(members?.["reviewer"]).toEqual({ nick: "reviewer", op: false, voice: false });
  });

  it("channel PRIVMSG flags a mention and marks the window", () => {
    const base = run(joined(), m("JOIN", ["#other"], "me!u@h"));
    const r = reduce(base, m("PRIVMSG", ["#dev", "hi Me!"], "coder!c@h"), 5);
    expect(r.mention).toBe(true);
    const win = r.state.windows["c:#dev"];
    expect(win?.mentioned).toBe(true);
    expect(win?.unread).toBe(true);
    expect(win?.lines.at(-1)?.from).toBe("coder");
  });

  it("own PRIVMSG is not a mention", () => {
    const r = reduce(joined(), m("PRIVMSG", ["#dev", "me me"], "me!u@h"), 5);
    expect(r.mention).toBe(false);
    expect(r.state.windows["c:#dev"]?.lines.at(-1)?.own).toBe(true);
  });

  it("PING returns PONG and adds no line", () => {
    const before = registered();
    const r = reduce(before, m("PING", ["tok"]), 1);
    expect(r.send).toEqual([{ command: "PONG", params: ["tok"] }]);
    expect(r.state.windows["status"]?.lines).toHaveLength(2);
  });

  it("unknown messages become status text and input is not mutated", () => {
    const before = registered();
    const snapshot = JSON.stringify(before);
    const r = reduce(before, m("FOO", ["a", "b"]), 1);
    expect(r.state.windows["status"]?.lines.at(-1)?.text).toBe("FOO a b");
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("is total on malformed input", () => {
    expect(() => reduce(initialState(), m("JOIN", []), 1)).not.toThrow();
    expect(() => reduce(initialState(), m("PRIVMSG", []), 1)).not.toThrow();
    expect(() => reduce(initialState(), m("353", ["me"]), 1)).not.toThrow();
  });
});
