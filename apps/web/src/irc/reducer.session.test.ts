import type { IrcMessage } from "@seance/irc-protocol";
import { describe, expect, it } from "vitest";
import { initialState, reduce } from "./reducer.js";
import { sessionStartText } from "./reducer.route.js";
import { resetForReconnect } from "./reset.js";
import type { ClientState } from "./types.js";

const m = (command: string, params: string[], prefix?: string): IrcMessage =>
  prefix === undefined ? { command, params } : { prefix, command, params };

function run(state: ClientState, ...msgs: IrcMessage[]): ClientState {
  return msgs.reduce((s, msg, i) => reduce(s, msg, 1_700_000_000_000 + i).state, state);
}

// pixel-match follow-up: Frame_01 node 1:1352 writes `Fri Nov 06 23:38:02 2026` (was `2026-11-06 23:38`).
const SESSION = /^--- Session start: [A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{2}:\d{2}:\d{2} \d{4}$/;
const sessionLines = (s: ClientState, key: string): number =>
  (s.windows[key]?.lines ?? []).filter((l) => SESSION.test(l.text)).length;

describe("session start lines", () => {
  const registered = (): ClientState =>
    run({ ...initialState(), phase: "registering" }, m("001", ["me", "Welcome"], "irc.test"));

  it("writes one to Status on registration, before the welcome numeric", () => {
    const s = registered();
    expect(sessionLines(s, "status")).toBe(1);
    expect(s.windows["status"]?.lines.map((l) => l.code)).toEqual([undefined, "001"]);
  });

  it("writes one to each new channel window, once", () => {
    let s = run(registered(), m("JOIN", ["#dev"], "me!u@h"));
    expect(sessionLines(s, "c:#dev")).toBe(1);
    expect(s.windows["c:#dev"]?.lines.at(-1)?.text).toBe("Now talking in #dev");
    s = run(s, m("JOIN", ["#dev"], "me!u@h"), m("JOIN", ["#dev"], "bob!b@h"));
    expect(sessionLines(s, "c:#dev")).toBe(1);
    s = run(s, m("JOIN", ["#ops"], "me!u@h"));
    expect(sessionLines(s, "c:#ops")).toBe(1);
  });

  it("writes a new Status line for each connection", () => {
    const s = run(resetForReconnect(registered()), m("001", ["me", "Welcome"], "irc.test"));
    expect(sessionLines(s, "status")).toBe(2);
  });

  it("keeps the numeric code on status lines", () => {
    const s = run(registered(), m("372", ["me", "- hello"], "irc.test"));
    expect(s.windows["status"]?.lines.at(-1)).toMatchObject({ kind: "motd", code: "372", text: "- hello" });
  });

  it("words topic changes as 'sets topic'", () => {
    const s = run(
      registered(),
      m("JOIN", ["#dev"], "me!u@h"),
      m("TOPIC", ["#dev", "hello"], "op!o@h"),
    );
    expect(s.windows["c:#dev"]?.lines.at(-1)?.text).toBe("op sets topic: hello");
  });
});

describe("sessionStartText", () => {
  it("uses the Frame_01 form in the local time zone, with English names and zero padding", () => {
    // Build the instant from local parts so the check holds in any time zone.
    const at = new Date(2026, 10, 6, 23, 38, 2).getTime();
    expect(sessionStartText(at)).toBe("--- Session start: Fri Nov 06 23:38:02 2026");
    expect(sessionStartText(new Date(2027, 0, 3, 4, 5, 6).getTime())).toBe("--- Session start: Sun Jan 03 04:05:06 2027");
  });
});
