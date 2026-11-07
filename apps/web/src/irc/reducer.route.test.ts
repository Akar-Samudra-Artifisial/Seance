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
const lastLine = (s: ClientState, key: string) => s.windows[key]?.lines.at(-1);

describe("reducer routing", () => {
  it("332 sets the topic, 331 and empty TOPIC clear it", () => {
    let s = run(joined(), m("332", ["me", "#dev", "Hello"], "irc.test"));
    expect(s.windows["c:#dev"]?.topic).toBe("Hello");
    s = run(s, m("TOPIC", ["#DEV", "New"], "coder!c@h"));
    expect(s.windows["c:#dev"]?.topic).toBe("New");
    expect(lastLine(s, "c:#dev")?.kind).toBe("topic");
    s = run(s, m("331", ["me", "#dev", "No topic is set"], "irc.test"));
    expect(s.windows["c:#dev"]?.topic).toBeUndefined();
  });

  it("MODE appends a mode line", () => {
    const s = run(joined(), m("MODE", ["#dev", "+o", "me"], "op!o@h"));
    expect(lastLine(s, "c:#dev")).toMatchObject({ kind: "mode", text: "op sets mode +o me" });
  });

  it("QUIT writes a line with reason in channels and the query window", () => {
    const s = run(
      joined(),
      m("JOIN", ["#dev"], "Bob!b@h"),
      m("PRIVMSG", ["me", "psst"], "Bob!b@h"),
      m("QUIT", ["bye"], "Bob!b@h"),
    );
    expect(lastLine(s, "c:#dev")).toMatchObject({ kind: "quit", text: "Bob has quit (bye)" });
    expect(lastLine(s, "q:bob")?.kind).toBe("quit");
    expect(s.windows["c:#dev"]?.members?.["bob"]).toBeUndefined();
  });

  it("NICK renames members and the query window", () => {
    const s = run(
      joined(),
      m("JOIN", ["#dev"], "Bob!b@h"),
      m("PRIVMSG", ["me", "psst"], "Bob!b@h"),
      m("NICK", ["Robert"], "Bob!b@h"),
    );
    expect(s.windows["c:#dev"]?.members?.["robert"]?.nick).toBe("Robert");
    expect(s.windows["q:bob"]).toBeUndefined();
    expect(s.windows["q:robert"]?.name).toBe("Robert");
    expect(s.order).toContain("q:robert");
  });

  it("own PART closes the window, keeps lines and activates Status; reopening restores them", () => {
    let s = run(joined(), m("PRIVMSG", ["#dev", "hello"], "c!c@h"), m("PART", ["#dev"], "me!u@h"));
    expect(s.windows["c:#dev"]).toBeUndefined();
    expect(s.activeKey).toBe("status");
    expect(s.closedLines["c:#dev"]?.length).toBeGreaterThan(0);
    s = run(s, m("JOIN", ["#dev"], "me!u@h"));
    expect(s.windows["c:#dev"]?.lines.some((l) => l.text === "hello")).toBe(true);
    expect(s.closedLines["c:#dev"]).toBeUndefined();
  });

  it("own KICK closes the window like PART", () => {
    const s = run(joined(), m("KICK", ["#dev", "me", "bye"], "op!o@h"));
    expect(s.windows["c:#dev"]).toBeUndefined();
    expect(s.activeKey).toBe("status");
    expect(s.closedLines["c:#dev"]?.at(-1)?.kind).toBe("kick");
  });

  it("KICK of a Known_Agent is exorcised-kick with parts; other nick is kick", () => {
    let s = run(joined(), m("JOIN", ["#dev"], "Coder!c@h"), m("JOIN", ["#dev"], "bob!b@h"));
    s = run(s, m("KICK", ["#dev", "Coder", "bad"], "op!o@h"));
    expect(lastLine(s, "c:#dev")).toMatchObject({
      kind: "exorcised-kick",
      exorcism: { agent: "Coder", kicker: "op", reason: "bad" },
    });
    s = run(s, m("KICK", ["#dev", "bob", "x"], "op!o@h"));
    const l = lastLine(s, "c:#dev");
    expect(l?.kind).toBe("kick");
    expect(l?.exorcism).toBeUndefined();
  });

  it("PART with exorcism reason is exorcised", () => {
    const s = run(joined(), m("JOIN", ["#dev"], "coder!c@h"), m("PART", ["#dev", "*** coder has been exorcised"], "coder!c@h"));
    expect(lastLine(s, "c:#dev")?.kind).toBe("exorcised");
  });

  it("PRIVMSG and NOTICE to own nick open an inactive query window", () => {
    let s = run(joined(), m("PRIVMSG", ["me", "hi"], "Bob!b@h"));
    expect(s.activeKey).toBe("c:#dev");
    expect(s.windows["q:bob"]).toMatchObject({ kind: "query", unread: true });
    s = run(joined(), m("NOTICE", ["me", "yo"], "Amy!a@h"));
    expect(lastLine(s, "q:amy")?.kind).toBe("notice");
  });

  it("mention in an inactive window sets mentioned; active window stays clear", () => {
    const s = run(joined(), m("JOIN", ["#b"], "me!u@h"), m("PRIVMSG", ["#dev", "ping me"], "c!c@h"));
    expect(s.windows["c:#dev"]).toMatchObject({ unread: true, mentioned: true });
    expect(s.windows["c:#b"]?.unread).toBe(false);
  });

  it("server NOTICE goes to Status; tool notices use tool kinds", () => {
    let s = run(joined(), m("NOTICE", ["me", "welcome"], "irc.test"));
    expect(lastLine(s, "status")?.kind).toBe("notice");
    s = run(s, m("NOTICE", ["#dev", "using tool: shell"], "coder!c@h"));
    expect(lastLine(s, "c:#dev")?.kind).toBe("tool");
    s = run(s, m("NOTICE", ["#dev", "using tool: shell denied"], "coder!c@h"));
    expect(lastLine(s, "c:#dev")?.kind).toBe("tool-denied");
  });

  it("305 writes to the Active_Window", () => {
    const s = run(joined(), m("305", ["me", "You are no longer marked as being away"], "irc.test"));
    expect(lastLine(s, "c:#dev")?.text).toBe("You are no longer marked as being away");
  });

  it("INVITE addressed to another nick goes to Status, not the Active_Window", () => {
    const s = run(joined(), m("INVITE", ["someone", "#x"], "Bob!b@h"));
    expect(lastLine(s, "c:#dev")?.kind).not.toBe("system");
    expect(lastLine(s, "status")?.kind).toBe("system");
  });

  it("unknown numeric goes to Status as a numeric line without the own nick", () => {
    const s = run(joined(), m("999", ["me", "odd", "thing"], "irc.test"));
    expect(lastLine(s, "status")).toMatchObject({ kind: "numeric", text: "odd thing" });
    expect(lastLine(s, "c:#dev")?.text).not.toBe("odd thing");
  });

  it("322/323 land in Status even when a channel is active", () => {
    const s = run(joined(), m("322", ["me", "#a", "3", ""], "irc.test"), m("323", ["me", "End of /LIST"], "irc.test"));
    expect(s.windows["status"]?.lines.map((l) => l.text).slice(-2)).toEqual(["#a 3", "End of /LIST"]);
    expect(lastLine(s, "c:#dev")?.text).toBe("You have joined #Dev");
  });

  it("agent MODE +o/+v and -o change member flags", () => {
    let s = run(joined(), m("JOIN", ["#dev"], "Coder!c@h"), m("JOIN", ["#dev"], "reviewer!r@h"));
    s = run(s, m("MODE", ["#dev", "+ov", "Coder", "reviewer"], "op!o@h"));
    expect(s.windows["c:#dev"]?.members?.["coder"]).toMatchObject({ op: true, voice: false });
    expect(s.windows["c:#dev"]?.members?.["reviewer"]).toMatchObject({ op: false, voice: true });
    expect(lastLine(s, "c:#dev")).toMatchObject({ kind: "mode", text: "op sets mode +ov Coder reviewer" });
    s = run(s, m("MODE", ["#dev", "-o", "coder"], "op!o@h"));
    expect(s.windows["c:#dev"]?.members?.["coder"]?.op).toBe(false);
  });

  it("agent KICK removes the member and logs agent, kicker and reason as an exorcism", () => {
    let s = run(joined(), m("JOIN", ["#dev"], "researcher!r@h"));
    s = run(s, m("KICK", ["#dev", "researcher", "off task"], "op!o@h"));
    expect(s.windows["c:#dev"]?.members?.["researcher"]).toBeUndefined();
    expect(lastLine(s, "c:#dev")?.exorcism).toEqual({ agent: "researcher", kicker: "op", reason: "off task" });
  });

  it("exorcism PART removes the member; a plain PART stays a part", () => {
    let s = run(joined(), m("JOIN", ["#dev"], "coder!c@h"), m("JOIN", ["#dev"], "bob!b@h"));
    s = run(s, m("PART", ["#dev", "*** coder has been exorcised"], "coder!c@h"));
    expect(s.windows["c:#dev"]?.members?.["coder"]).toBeUndefined();
    s = run(s, m("PART", ["#dev", "bye"], "bob!b@h"));
    expect(lastLine(s, "c:#dev")).toMatchObject({ kind: "part", text: "bob has left #dev (bye)" });
  });

  it("interleaved WHOIS replies for two nicks group per nick amid channel lines", () => {
    const s = run(
      joined(),
      m("311", ["me", "Coder", "c", "h", "*", "Coder Agent"], "irc.test"),
      m("311", ["me", "Bob", "b", "h2", "*", "Bob B"], "irc.test"),
      m("PRIVMSG", ["#dev", "chatter"], "x!x@h"),
      m("319", ["me", "Coder", "@#dev"], "irc.test"),
      m("318", ["me", "Coder", "End"], "irc.test"),
    );
    const blocks = (s.windows["c:#dev"]?.lines ?? []).filter((l) => l.kind === "whois");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.whois?.channels).toEqual(["@#dev"]);
    expect(Object.keys(s.whoisPending)).toEqual(["bob"]);
    expect((s.windows["c:#dev"]?.lines ?? []).some((l) => l.text === "chatter")).toBe(true);
  });

  it("401 for a nick with no pending WHOIS is still an error line", () => {
    const s = run(joined(), m("401", ["me", "ghost", "No such nick/channel"], "irc.test"));
    expect(lastLine(s, "c:#dev")).toMatchObject({ kind: "error", text: "ghost No such nick/channel" });
  });

  it("INVITE and 306 write to the Active_Window", () => {
    let s = run(joined(), m("INVITE", ["me", "#x"], "Bob!b@h"));
    expect(lastLine(s, "c:#dev")?.text).toBe("Bob invites you to #x");
    s = run(s, m("306", ["me", "You have been marked as being away"], "irc.test"));
    expect(lastLine(s, "c:#dev")?.text).toBe("You have been marked as being away");
  });
});
