import { parse, isParseError } from "@seance/irc-protocol";
import { describe, expect, it } from "vitest";
import { initialState, reduce } from "./reducer.js";
import { resetForReconnect } from "./reset.js";
import type { ClientState } from "./types.js";

function feed(state: ClientState, lines: readonly string[]): ClientState {
  let s = state;
  for (const line of lines) {
    const msg = parse(line);
    if (isParseError(msg)) throw new Error(`bad test line: ${line}`);
    s = reduce(s, msg, 1000).state;
  }
  return s;
}

function populated(): ClientState {
  return feed({ ...initialState("alice"), phase: "registering" }, [
    ":srv 001 alice :Welcome",
    ":alice!u@h JOIN #test",
    ":srv 332 alice #test :hello topic",
    ":srv 353 alice = #test :@bob +carol alice",
    ":srv 366 alice #test :End of NAMES",
    ":bob!u@h PRIVMSG #test :hi there",
  ]);
}

describe("resetForReconnect", () => {
  it("keeps lines, clears members, topics and pending state, sets connecting", () => {
    const before = populated();
    const chan = before.windows["c:#test"];
    expect(chan?.topic).toBe("hello topic");
    expect(Object.keys(chan?.members ?? {}).length).toBeGreaterThan(0);

    const withPending: ClientState = {
      ...before,
      whoisPending: { bob: { nick: "bob", channels: [], special: [] } },
      expectingNames: ["#test"],
    };
    const after = resetForReconnect(withPending);

    expect(after.phase).toBe("connecting");
    expect(after.whoisPending).toEqual({});
    expect(after.expectingNames).toEqual([]);
    expect(after.windows["c:#test"]?.members).toEqual({});
    expect(after.windows["c:#test"]?.topic).toBeUndefined();
    for (const [key, win] of Object.entries(withPending.windows)) {
      expect(after.windows[key]?.lines).toEqual(win.lines);
    }
    expect(after.order).toEqual(before.order);
    expect(after.activeKey).toBe(before.activeKey);
    expect(after.ownNick).toBe("alice");
    expect(after.closedLines).toEqual(before.closedLines);
  });

  it("does not mutate its input", () => {
    const before = populated();
    const snapshot = structuredClone(before);
    resetForReconnect(before);
    expect(before).toEqual(snapshot);
  });
});
