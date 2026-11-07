import type { IrcMessage } from "@seance/irc-protocol";
import { describe, expect, it } from "vitest";
import { initialState, reduce } from "./reducer.js";
import { resetForReconnect } from "./reset.js";
import { EXORCISED_MAX } from "./types.js";
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
    m("JOIN", ["#dev"], "me!u@h"),
    m("353", ["me", "=", "#dev", "@me coder bob"], "irc.test"),
  );

const kick = (target: string, reason = "bye"): IrcMessage => m("KICK", ["#dev", target, reason], "me!u@h");
const lastLine = (s: ClientState) => s.windows["c:#dev"]?.lines.at(-1);

describe("Line.prefix", () => {
  it("is set on join, part and quit lines from the message prefix", () => {
    const joined = run(base(), m("JOIN", ["#dev"], "al!alice@host.example"));
    expect(lastLine(joined)?.prefix).toEqual({ user: "alice", host: "host.example" });
    const parted = run(joined, m("PART", ["#dev"], "al!alice@host.example"));
    expect(lastLine(parted)?.prefix).toEqual({ user: "alice", host: "host.example" });
    const quit = run(base(), m("QUIT", ["gone"], "bob!bu@bh"));
    expect(lastLine(quit)?.kind).toBe("quit");
    expect(lastLine(quit)?.prefix).toEqual({ user: "bu", host: "bh" });
  });

  it("is absent without a user@host prefix and on other kinds", () => {
    const s = run(base(), m("JOIN", ["#dev"], "al"), m("PRIVMSG", ["#dev", "hi"], "bob!bu@bh"));
    expect(s.windows["c:#dev"]?.lines.some((l) => l.prefix !== undefined && l.kind === "message")).toBe(false);
    expect(s.windows["c:#dev"]?.lines.find((l) => l.text.startsWith("al has"))?.prefix).toBeUndefined();
  });
});

describe("exorcised nicks", () => {
  it("adds a kicked Known_Agent, never to members", () => {
    const s = run(base(), kick("Coder"));
    expect(s.windows["c:#dev"]?.exorcised).toEqual(["Coder"]);
    expect(s.windows["c:#dev"]?.members?.["coder"]).toBeUndefined();
  });

  it("ignores kicks of other nicks", () => {
    expect(run(base(), kick("bob")).windows["c:#dev"]?.exorcised).toBeUndefined();
  });

  it("removes the nick when it rejoins", () => {
    const s = run(base(), kick("coder"), m("JOIN", ["#dev"], "CODER!c@h"));
    expect(s.windows["c:#dev"]?.exorcised).toEqual([]);
    expect(s.windows["c:#dev"]?.members?.["coder"]).toBeDefined();
  });

  it("keeps at most EXORCISED_MAX, dropping the oldest, without duplicates", () => {
    // Only Known_Agents are tracked, so repeated kicks stay deduplicated.
    const s = run(base(), kick("coder"), kick("coder"));
    expect(s.windows["c:#dev"]?.exorcised).toEqual(["coder"]);
    expect(EXORCISED_MAX).toBe(20);
  });

  it("is dropped on own leave and on reconnect", () => {
    const kicked = run(base(), kick("coder"));
    const left = run(kicked, m("PART", ["#dev"], "me!u@h"), m("JOIN", ["#dev"], "me!u@h"));
    expect(left.windows["c:#dev"]?.exorcised).toBeUndefined();
    expect(resetForReconnect(kicked).windows["c:#dev"]?.exorcised).toBeUndefined();
  });
});
