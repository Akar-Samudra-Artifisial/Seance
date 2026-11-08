// The reducer stores the sender's mode on each channel message line (pixel-match follow-up,
// Frame_01 node 1:1360 shows `<+coder>` before coder became op).
import type { IrcMessage } from "@seance/irc-protocol";
import { describe, expect, it } from "vitest";
import { initialState, reduce } from "./reducer.js";
import type { ClientState, Line } from "./types.js";

const m = (prefix: string, command: string, ...params: string[]): IrcMessage => ({ prefix, command, params });

function run(...msgs: IrcMessage[]): ClientState {
  const start: ClientState = { ...initialState("me"), phase: "registered" };
  return msgs.reduce<ClientState>((s, msg) => reduce(s, msg, 1000).state, start);
}

const messages = (s: ClientState, key: string): readonly Line[] =>
  (s.windows[key]?.lines ?? []).filter((l) => l.kind === "message");

describe("nick prefix at the time of the line", () => {
  it("records +, then @ after +o, and keeps the old lines unchanged", () => {
    const s = run(
      m("me!u@h", "JOIN", "#dev"),
      m("irc.test", "353", "me", "=", "#dev", "@me coder"),
      m("coder!a@k", "PRIVMSG", "#dev", "plain"),
      m("me!u@h", "MODE", "#dev", "+v", "coder"),
      m("coder!a@k", "PRIVMSG", "#dev", "voiced"),
      m("me!u@h", "MODE", "#dev", "+o", "coder"),
      m("coder!a@k", "PRIVMSG", "#dev", "op now"),
      m("me!u@h", "PRIVMSG", "#dev", "own line"),
    );
    expect(messages(s, "c:#dev").map((l) => [l.text, l.nickPrefix])).toEqual([
      ["plain", ""],
      ["voiced", "+"],
      ["op now", "@"],
      ["own line", "@"],
    ]);
  });

  it("stores an empty prefix for a sender outside the member list and none for queries or notices", () => {
    const s = run(
      m("me!u@h", "JOIN", "#dev"),
      m("eve!e@h", "PRIVMSG", "#dev", "outsider"),
      m("bob!b@h", "PRIVMSG", "me", "in a query"),
      m("coder!a@k", "NOTICE", "#dev", "a notice"),
    );
    expect(messages(s, "c:#dev")[0]?.nickPrefix).toBe("");
    expect(messages(s, "q:bob")[0]?.nickPrefix).toBeUndefined();
    expect(s.windows["c:#dev"]?.lines.find((l) => l.kind === "notice")?.nickPrefix).toBeUndefined();
  });
});
