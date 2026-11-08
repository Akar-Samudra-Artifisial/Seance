import type { IrcMessage } from "@seance/irc-protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AWAY_MAX, goneText } from "./reducer.away.js";
import { initialState, reduce } from "./reducer.js";
import { resetForReconnect } from "./reset.js";
import type { ClientState } from "./types.js";

const SRV = "ircd.test";
const from = (nick: string, command: string, ...params: string[]): IrcMessage => ({
  prefix: `${nick}!u@h`,
  command,
  params,
});
const srv = (command: string, ...params: string[]): IrcMessage => ({ prefix: SRV, command, params });

function run(start: ClientState, msgs: readonly IrcMessage[]): ClientState {
  return msgs.reduce((s, m) => reduce(s, m, 1000).state, start);
}

function setup(): ClientState {
  return run({ ...initialState("me"), phase: "registered" }, [
    from("me", "JOIN", "#a"),
    from("me", "JOIN", "#b"),
    srv("353", "me", "=", "#a", "me Bob"),
    srv("353", "me", "=", "#b", "me"),
  ]);
}

const lastText = (s: ClientState, key: string): string | undefined => s.windows[key]?.lines.at(-1)?.text;

describe("away tracking", () => {
  it("marks on inbound AWAY and logs an action line only in channels holding the member", () => {
    const s = run(setup(), [from("Bob", "AWAY", "gone fishing")]);
    expect(s.away["bob"]).toBe("gone fishing");
    const line = s.windows["c:#a"]?.lines.at(-1);
    expect(line).toMatchObject({ kind: "action", from: "Bob", text: "is away (gone fishing)" });
    expect(lastText(s, "c:#b")).not.toContain("away");
  });

  // pixel-match follow-up (Frame_01 node 1:1368): the back line carries the away time when the
  // client saw the `is away` line; both messages here arrive at the same clock, so it reads 00:00:00.
  it("clears on AWAY without text and logs 'is back (gone hh:mm:ss)'", () => {
    const s = run(setup(), [from("Bob", "AWAY", "x"), from("Bob", "AWAY")]);
    expect(s.away["bob"]).toBeUndefined();
    expect(s.windows["c:#a"]?.lines.at(-1)).toMatchObject({
      kind: "action",
      from: "Bob",
      text: "is back (gone 00:00:00)",
    });
  });

  it("measures the time since the latest 'is away' line", () => {
    const at = (s: ClientState, m: IrcMessage, ms: number): ClientState => reduce(s, m, ms).state;
    let s = at(setup(), from("Bob", "AWAY", "lunch"), 10_000);
    s = at(s, from("Bob", "AWAY"), 10_000 + 108_000);
    expect(lastText(s, "c:#a")).toBe("is back (gone 00:01:48)");
    // A second away period is measured from its own start.
    s = at(s, from("Bob", "AWAY", "again"), 500_000);
    s = at(s, from("Bob", "AWAY"), 500_000 + 3_725_000);
    expect(lastText(s, "c:#a")).toBe("is back (gone 01:02:05)");
  });

  it("says plain 'is back' when the away start is unknown", () => {
    // Marked by 301 (no line) or never marked: no duration to show.
    const fromWhois = run(setup(), [srv("301", "me", "Bob", "brb"), from("Bob", "AWAY")]);
    expect(lastText(fromWhois, "c:#a")).toBe("is back");
    const never = run(setup(), [from("Bob", "AWAY")]);
    expect(lastText(never, "c:#a")).toBe("is back");
  });

  it("formats gone times as hh:mm:ss without a 24 h cap", () => {
    expect(goneText(0)).toBe("00:00:00");
    expect(goneText(108_999)).toBe("00:01:48");
    expect(goneText(100 * 3600_000)).toBe("100:00:00");
    expect(goneText(-5)).toBe("00:00:00");
  });

  it("formats non-finite gone times as 00:00:00", () => {
    expect(goneText(Number.NaN)).toBe("00:00:00");
    expect(goneText(Number.POSITIVE_INFINITY)).toBe("00:00:00");
    expect(goneText(Number.NEGATIVE_INFINITY)).toBe("00:00:00");
  });

  it("ignores a user's own `/me is away (…)` or `/me is back` when measuring the gone time", () => {
    const at = (s: ClientState, m: IrcMessage, ms: number): ClientState => reduce(s, m, ms).state;
    const act = (text: string): IrcMessage => from("Bob", "PRIVMSG", "#a", `\x01ACTION ${text}\x01`);
    // Marked by 301 (no line); a fake action line must not give a start.
    let s = at(setup(), srv("301", "me", "Bob", "brb"), 1_000);
    s = at(s, act("is away (fake)"), 5_000);
    expect(s.windows["c:#a"]?.lines.at(-1)).toMatchObject({ kind: "action", text: "is away (fake)" });
    s = at(s, from("Bob", "AWAY"), 20_000);
    expect(lastText(s, "c:#a")).toBe("is back");
    // A real away start is kept even when fake lines follow it.
    s = at(s, from("Bob", "AWAY", "lunch"), 10_000);
    s = at(s, act("is away (later)"), 50_000);
    s = at(s, act("is back"), 60_000);
    s = at(s, from("Bob", "AWAY"), 10_000 + 108_000);
    expect(lastText(s, "c:#a")).toBe("is back (gone 00:01:48)");
  });

  it("marks on 301 and keeps the reply line", () => {
    const s = run(setup(), [srv("301", "me", "Bob", "brb")]);
    expect(s.away["bob"]).toBe("brb");
    expect(lastText(s, s.activeKey)).toBe("Bob is away: brb");
  });

  it("306 marks and 305 clears the own nick", () => {
    const a = run(setup(), [srv("306", "me", "You have been marked as being away")]);
    expect(Object.keys(a.away)).toEqual(["me"]);
    const b = run(a, [srv("305", "me", "You are no longer marked as being away")]);
    expect(Object.keys(b.away)).toEqual([]);
  });

  it("follows NICK and is dropped on QUIT", () => {
    const a = run(setup(), [from("Bob", "AWAY", "x"), from("Bob", "NICK", "Rob")]);
    expect(Object.keys(a.away)).toEqual(["rob"]);
    const b = run(a, [from("Rob", "QUIT", "bye")]);
    expect(Object.keys(b.away)).toEqual([]);
  });

  it("is cleared on reconnect", () => {
    const s = resetForReconnect(run(setup(), [from("Bob", "AWAY", "x")]));
    expect(Object.keys(s.away)).toEqual([]);
  });

  it("ignores AWAY without a prefix", () => {
    const s = run(setup(), [{ command: "AWAY", params: ["x"] }]);
    expect(Object.keys(s.away)).toEqual([]);
  });

  it("keeps at most AWAY_MAX entries, dropping the oldest", () => {
    const msgs = Array.from({ length: AWAY_MAX + 5 }, (_, i) => from(`n${i}`, "AWAY", "x"));
    const s = run(setup(), msgs);
    expect(Object.keys(s.away)).toHaveLength(AWAY_MAX);
    expect(s.away["n0"]).toBeUndefined();
    expect(s.away[`n${AWAY_MAX + 4}`]).toBe("x");
  });
});

describe("P7 away bookkeeping", () => {
  const nick = fc.oneof(
    fc.constantFrom("constructor", "__proto__", "toString", "Bob", "bob", "Al[", "al{"),
    fc.stringMatching(/^[a-z][a-z0-9]{0,5}$/),
  );
  const step = fc.oneof(
    fc.tuple(fc.constant("away"), nick, fc.constantFrom("", "x")),
    fc.tuple(fc.constant("301"), nick, fc.constantFrom("", "x")),
    fc.tuple(fc.constant("nick"), nick, nick),
    fc.tuple(fc.constant("quit"), nick, fc.constant("")),
  );

  it("P7 away bookkeeping stays bounded, null-prototype and keyed by irc_lower", () => {
    fc.assert(
      fc.property(fc.array(step, { maxLength: 60 }), (steps) => {
        const msgs = steps.map(([kind, n, arg]): IrcMessage => {
          switch (kind) {
            case "away":
              return from(n, "AWAY", ...(arg === "" ? [] : [arg]));
            case "301":
              return srv("301", "me", n, arg);
            case "nick":
              return from(n, "NICK", arg);
            default:
              return from(n, "QUIT", "bye");
          }
        });
        const s = run(setup(), msgs);
        expect(Object.getPrototypeOf(s.away)).toBeNull();
        expect(Object.keys(s.away).length).toBeLessThanOrEqual(AWAY_MAX);
        for (const k of Object.keys(s.away)) {
          expect(k).toBe(k.toLowerCase().replace(/\[/g, "{").replace(/\]/g, "}"));
        }
      }),
    );
  });

  it("P7 away bookkeeping matches an ordered reference model (NICK moves, QUIT removes, cap evicts oldest)", () => {
    const lower = (n: string): string =>
      n.toLowerCase().replace(/\[/g, "{").replace(/\]/g, "}").replace(/\\/g, "|").replace(/~/g, "^");
    const wide = fc.oneof(
      { weight: 3, arbitrary: fc.integer({ min: 0, max: AWAY_MAX + 40 }).map((i) => `N${i}`) },
      { weight: 1, arbitrary: fc.constantFrom("constructor", "__proto__", "toString", "Bob", "bob", "Al[", "al{") },
    );
    const wstep = fc.oneof(
      { weight: 5, arbitrary: fc.tuple(fc.constant("away"), wide, fc.constantFrom("", "x", "y")) },
      { weight: 3, arbitrary: fc.tuple(fc.constant("301"), wide, fc.constantFrom("", "x", "y")) },
      { weight: 2, arbitrary: fc.tuple(fc.constant("nick"), wide, wide) },
      { weight: 2, arbitrary: fc.tuple(fc.constant("quit"), wide, fc.constant("")) },
    );
    fc.assert(
      fc.property(fc.array(wstep, { maxLength: 500 }), (steps) => {
        const model = new Map<string, string>();
        const mark = (n: string, t: string): void => {
          const k = lower(n);
          model.delete(k);
          model.set(k, t);
          while (model.size > AWAY_MAX) model.delete(model.keys().next().value as string);
        };
        const msgs: IrcMessage[] = [];
        for (const [kind, n, arg] of steps) {
          switch (kind) {
            case "away":
              msgs.push(from(n, "AWAY", ...(arg === "" ? [] : [arg])));
              if (arg === "") model.delete(lower(n));
              else mark(n, arg);
              break;
            case "301":
              msgs.push(srv("301", "me", n, arg));
              mark(n, arg);
              break;
            case "nick": {
              msgs.push(from(n, "NICK", arg));
              const t = model.get(lower(n));
              if (t !== undefined) {
                model.delete(lower(n));
                mark(arg, t);
              }
              break;
            }
            default:
              msgs.push(from(n, "QUIT", "bye"));
              model.delete(lower(n));
          }
        }
        const s = run(setup(), msgs);
        expect(Object.getPrototypeOf(s.away)).toBeNull();
        expect(Object.keys(s.away).length).toBeLessThanOrEqual(AWAY_MAX);
        const byKey = (a: readonly [string, string], b: readonly [string, string]): number =>
          a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
        expect(Object.entries(s.away).sort(byKey)).toEqual([...model.entries()].sort(byKey));
      }),
      { numRuns: 200 },
    );
  });

  it("P7 away bookkeeping treats prototype names like any nick", () => {
    const s = run(setup(), [from("__proto__", "AWAY", "x"), srv("301", "me", "constructor", "y")]);
    expect(Object.hasOwn(s.away, "__proto__")).toBe(true);
    expect(s.away["constructor"]).toBe("y");
    const q = run(s, [from("__proto__", "QUIT", "")]);
    expect(Object.hasOwn(q.away, "__proto__")).toBe(false);
  });
});
