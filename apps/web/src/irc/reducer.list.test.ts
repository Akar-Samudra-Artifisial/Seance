import type { IrcMessage } from "@seance/irc-protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { initialState, reduce } from "./reducer.js";
import { clearList, failList, startList } from "./reducer.list.js";
import { resetForReconnect } from "./reset.js";
import type { ClientState } from "./types.js";

const SRV = "ircd.test";
const msg = (command: string, ...params: string[]): IrcMessage => ({ prefix: SRV, command, params });
const step = (s: ClientState, m: IrcMessage): ReturnType<typeof reduce> => reduce(s, m, 5000);
function registered(): ClientState {
  const base = { ...initialState("me"), phase: "registered" as const };
  const joined = reduce(base, { prefix: "me!u@h", command: "JOIN", params: ["#Joined"] }, 1).state;
  return reduce(joined, msg("353", "me", "=", "#Joined", "@me coder +Bob"), 2).state;
}
const statusTexts = (s: ClientState): string[] => (s.windows["status"]?.lines ?? []).map((l) => l.text);

describe("channel list reducer (web-client-extras Req 1.3, 1.4, 2)", () => {
  it("collects 321/322/323 while loading, and nothing goes to the Status window", () => {
    let s = startList(registered(), 100);
    const before = statusTexts(s).length;
    s = step(s, msg("321", "me", "Channel", "Users  Name")).state;
    s = step(s, msg("322", "me", "#a", "2", "Topic A")).state;
    s = step(s, msg("322", "me", "#b", "0", "")).state;
    expect(s.list?.status).toBe("loading");
    s = step(s, msg("323", "me", "End of /LIST")).state;
    expect(s.list?.status).toBe("ready");
    expect(s.list?.rows.map((r) => r.name)).toEqual(["#a", "#b"]);
    expect(s.list?.listedAt).toBe(5000);
    expect(statusTexts(s)).toHaveLength(before);
  });

  it("keeps the old behaviour without a loading request: 322/323 land in Status", () => {
    let s = registered();
    s = step(s, msg("322", "me", "#a", "2", "Topic A")).state;
    s = step(s, msg("323", "me", "End of /LIST")).state;
    expect(statusTexts(s)).toContain("#a 2 Topic A");
    expect(statusTexts(s)).toContain("End of /LIST");
    expect(s.list).toBeUndefined();
  });

  it("does not collect rows after 323 (a later /list goes to Status)", () => {
    let s = startList(registered(), 1);
    s = step(s, msg("323", "me", "End")).state;
    s = step(s, msg("322", "me", "#late", "1", "x")).state;
    expect(s.list?.rows).toEqual([]);
    expect(statusTexts(s)).toContain("#late 1 x");
  });

  it("drops invalid rows and caps at 500 with a truncated flag", () => {
    let s = startList(registered(), 1);
    s = step(s, msg("322", "me", "#bad name", "1", "x")).state;
    s = step(s, msg("322", "me", "#bad", "many", "x")).state;
    for (let i = 0; i < 503; i += 1) s = step(s, msg("322", "me", `#c${i}`, "1", "t")).state;
    expect(s.list?.rows).toHaveLength(500);
    expect(s.list?.truncated).toBe(true);
  });

  it("counts agents of a joined channel from its members and asks NAMES for the rest", () => {
    let s = startList(registered(), 1);
    s = step(s, msg("322", "me", "#joined", "3", "j")).state;
    s = step(s, msg("322", "me", "#far", "2", "f")).state;
    s = step(s, msg("322", "me", "#other", "1", "o")).state;
    const done = step(s, msg("323", "me", "End"));
    expect(done.send).toEqual([{ command: "NAMES", params: ["#far,#other"] }]);
    const rows = done.state.list?.rows ?? [];
    expect(rows.find((r) => r.name === "#joined")?.agents).toBe(1);
    expect(rows.find((r) => r.name === "#far")?.agents).toBeNull();
  });

  it("finishes a pending channel at 366 and keeps its replies out of the Status window", () => {
    let s = startList(registered(), 1);
    s = step(s, msg("322", "me", "#far", "3", "f")).state;
    s = step(s, msg("323", "me", "End")).state;
    const before = statusTexts(s).length;
    s = step(s, msg("353", "me", "=", "#far", "@Coder reviewer bob")).state;
    s = step(s, msg("353", "me", "=", "#far", "researcher")).state;
    expect(s.list?.rows[0]?.agents).toBeNull();
    s = step(s, msg("366", "me", "#far", "End of /NAMES list")).state;
    expect(s.list?.rows[0]?.agents).toBe(3);
    expect(s.list?.pendingNames).toEqual([]);
    expect(statusTexts(s)).toHaveLength(before);
  });

  it("ignores 353/366 for channels it did not ask about", () => {
    let s = startList(registered(), 1);
    s = step(s, msg("322", "me", "#far", "3", "f")).state;
    s = step(s, msg("323", "me", "End")).state;
    s = step(s, msg("353", "me", "=", "#unrelated", "coder")).state;
    s = step(s, msg("366", "me", "#unrelated", "End")).state;
    expect(s.list?.rows[0]?.agents).toBeNull();
    expect(s.list?.pendingNames).toEqual(["c:#far"]);
  });

  it("failList marks a loading list failed and leaves a ready list alone", () => {
    const loading = startList(registered(), 1);
    expect(failList(loading).list?.status).toBe("failed");
    const ready = step(loading, msg("323", "me", "End")).state;
    expect(failList(ready).list?.status).toBe("ready");
  });

  it("keeps the first row of a repeated channel, under IRC case-mapping (review finding 2)", () => {
    let s = startList(registered(), 1);
    s = step(s, msg("322", "me", "#Dup", "3", "first")).state;
    s = step(s, msg("322", "me", "#dup", "9", "second")).state;
    s = step(s, msg("322", "me", "#[x]", "1", "a")).state;
    s = step(s, msg("322", "me", "#{x}", "2", "b")).state; // rfc1459: {} equal []
    expect(s.list?.rows.map((r) => [r.name, r.users, r.topic])).toEqual([
      ["#Dup", 3, "first"],
      ["#[x]", 1, "a"],
    ]);
  });

  it("treats prototype names as plain channel names (review finding 2)", () => {
    let s = startList(registered(), 1);
    for (const name of ["constructor", "#constructor", "__proto__", "#__proto__", "constructor"]) {
      s = step(s, msg("322", "me", name, "1", "t")).state;
    }
    expect(s.list?.rows.map((r) => r.name)).toEqual(["constructor", "#constructor", "__proto__", "#__proto__"]);
    const done = step(s, msg("323", "me", "End"));
    expect(done.send).toEqual([{ command: "NAMES", params: ["constructor,#constructor,__proto__,#__proto__"] }]);
    s = step(done.state, msg("353", "me", "=", "constructor", "coder")).state;
    s = step(s, msg("366", "me", "constructor", "End")).state;
    expect(s.list?.rows.find((r) => r.name === "constructor")?.agents).toBe(1);
    expect(s.list?.rows.find((r) => r.name === "#constructor")?.agents).toBeNull();
  });

  it("is cleared on reconnect and by clearList", () => {
    const s = startList(registered(), 1);
    expect(resetForReconnect(s).list).toBeUndefined();
    expect(clearList(s).list).toBeUndefined();
  });

  it("P3 the row cap holds for any number of replies", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 900 }), (n) => {
        let s = startList(registered(), 1);
        for (let i = 0; i < n; i += 1) s = reduce(s, msg("322", "me", `#c${i}`, "1", "t"), 1).state;
        expect(s.list?.rows.length).toBe(Math.min(n, 500));
        expect(s.list?.truncated).toBe(n > 500);
      }),
      { numRuns: 15 },
    );
  });
});
