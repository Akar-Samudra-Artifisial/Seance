// web-client-pixel-match: invite lines (R6.2) and the empty-line gate (R9.2).
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
const lines = (s: ClientState, key: string) => s.windows[key]?.lines ?? [];

describe("invite lines (R6.2)", () => {
  it("341 writes `<me> invited <target>` as an invite line in the channel", () => {
    const s = run(joined(), m("341", ["me", "coder", "#dev"], "irc.test"));
    expect(lines(s, "c:#dev").at(-1)).toMatchObject({ kind: "invite", text: "me invited coder" });
  });

  it("341 for a channel without a window goes to Status", () => {
    const s = run(joined(), m("341", ["me", "coder", "#other"], "irc.test"));
    expect(lines(s, "status").at(-1)).toMatchObject({ kind: "invite", text: "me invited coder" });
  });

  it("an INVITE to the own nick is an invite line", () => {
    const s = run(joined(), m("INVITE", ["me", "#x"], "Bob!b@h"));
    expect(lines(s, "c:#dev").at(-1)).toMatchObject({ kind: "invite", text: "Bob invites you to #x" });
  });
});

describe("empty-line gate (R9.2)", () => {
  it("drops a NOTICE that holds only control codes", () => {
    const before = joined();
    const s = run(before, m("NOTICE", ["#dev", "\x02\x0f\x0304"], "coder!c@h"));
    expect(lines(s, "c:#dev")).toHaveLength(lines(before, "c:#dev").length);
  });

  it("drops a PRIVMSG of spaces and an empty action, and marks nothing unread", () => {
    const base = run(joined(), m("JOIN", ["#ops"], "me!u@h"));
    const s = run(base, m("PRIVMSG", ["#dev", "   "], "coder!c@h"), m("PRIVMSG", ["#dev", "\x01ACTION\x01"], "coder!c@h"));
    expect(lines(s, "c:#dev")).toHaveLength(lines(base, "c:#dev").length);
    expect(s.windows["c:#dev"]?.unread).toBe(base.windows["c:#dev"]?.unread);
  });

  it("keeps a line with visible text, and keeps blank MOTD rows", () => {
    const s = run(joined(), m("PRIVMSG", ["#dev", "\x0312ok"], "coder!c@h"), m("372", ["me", "- "], "irc.test"));
    expect(lines(s, "c:#dev").at(-1)).toMatchObject({ kind: "message", text: "\x0312ok" });
    expect(lines(s, "status").at(-1)).toMatchObject({ kind: "motd" });
  });
});
