import type { IrcMessage } from "@seance/irc-protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AWAY_MAX } from "./reducer.away.js";
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

  it("clears on AWAY without text and logs 'is back'", () => {
    const s = run(setup(), [from("Bob", "AWAY", "x"), from("Bob", "AWAY")]);
    expect(s.away["bob"]).toBeUndefined();
    expect(s.windows["c:#a"]?.lines.at(-1)).toMatchObject({ kind: "action", from: "Bob", text: "is back" });
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
