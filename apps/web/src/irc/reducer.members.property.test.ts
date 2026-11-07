import { irc_lower } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import fc from "fast-check";
import { channelKey } from "./casemap.js";
import { describe, expect, it } from "vitest";
import { initialState, reduce } from "./reducer.js";
import type { ClientState } from "./types.js";

// Feature: web-client-basic, Property 2: Member sets match a reference model
// **Validates: Requirements 6.4, 6.7, 6.8, 6.9, 6.10, 12.1, 12.2, 12.3, 12.5, 17.3**

const OWN = "me";
const OWN_VARIANTS = ["me", "ME", "Me"] as const;

/** Other nicks with rfc1459 case variants: `[` `{`, `]` `}`, `\` `|`, `~` `^`. */
const OTHER_VARIANTS: readonly (readonly string[])[] = [
  ["Al[x]", "al{x}", "AL[X]", "Al{X}"],
  ["Bo\\y", "bo|y", "BO\\Y"],
  ["Cy~z", "cy^z", "CY^Z"],
  ["Di]", "di}", "DI}"],
  ["ed", "Ed", "ED"],
];
const OTHER_NICKS: readonly string[] = OTHER_VARIANTS.flat();

/** Two channels, each with case variants (`~` and `^` are partners). */
const CHANNELS: readonly (readonly string[])[] = [
  ["#Dev", "#dev", "#DEV"],
  ["#Ops~", "#ops^", "#OPS^"],
];
const ALL_CHANNELS: readonly string[] = CHANNELS.flat();

const nickArb = fc.constantFrom(...OTHER_NICKS);
const chanArb = fc.constantFrom(...ALL_CHANNELS);
const ownArb = fc.constantFrom(...OWN_VARIANTS);
const anyNickArb = fc.oneof({ weight: 6, arbitrary: nickArb }, { weight: 1, arbitrary: ownArb });

type Flag = "o" | "v";
interface ModeItem {
  readonly add: boolean;
  readonly flag: Flag;
  readonly nick: string;
}

type Op =
  | { readonly t: "join"; readonly chan: string; readonly nick: string }
  | { readonly t: "ownJoin"; readonly chan: string }
  | { readonly t: "names"; readonly chan: string; readonly entries: readonly NamesEntry[] }
  | { readonly t: "part"; readonly chan: string; readonly nick: string }
  | { readonly t: "kick"; readonly chan: string; readonly target: string; readonly by: string }
  | { readonly t: "quit"; readonly nick: string }
  | { readonly t: "nick"; readonly from: string; readonly to: string }
  | { readonly t: "mode"; readonly chan: string; readonly items: readonly ModeItem[] };

interface NamesEntry {
  readonly nick: string;
  readonly op: boolean;
  readonly voice: boolean;
}

const namesEntryArb: fc.Arbitrary<NamesEntry> = fc.record({
  nick: anyNickArb,
  op: fc.boolean(),
  voice: fc.boolean(),
});

const modeItemArb: fc.Arbitrary<ModeItem> = fc.record({
  add: fc.boolean(),
  flag: fc.constantFrom<Flag>("o", "v"),
  nick: anyNickArb,
});

const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ t: fc.constant("join" as const), chan: chanArb, nick: nickArb }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("ownJoin" as const), chan: chanArb }) },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant("names" as const),
      chan: chanArb,
      entries: fc.array(namesEntryArb, { maxLength: 5 }),
    }),
  },
  { weight: 4, arbitrary: fc.record({ t: fc.constant("part" as const), chan: chanArb, nick: anyNickArb }) },
  {
    weight: 3,
    arbitrary: fc.record({ t: fc.constant("kick" as const), chan: chanArb, target: anyNickArb, by: nickArb }),
  },
  { weight: 3, arbitrary: fc.record({ t: fc.constant("quit" as const), nick: nickArb }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant("nick" as const), from: nickArb, to: nickArb }) },
  {
    weight: 8,
    arbitrary: fc.record({
      t: fc.constant("mode" as const),
      chan: chanArb,
      items: fc.array(modeItemArb, { minLength: 1, maxLength: 3 }),
    }),
  },
);

const prefixOf = (nick: string): string => `${nick}!u@h`;

function toMessage(op: Op): IrcMessage {
  switch (op.t) {
    case "join":
      return { prefix: prefixOf(op.nick), command: "JOIN", params: [op.chan] };
    case "ownJoin":
      return { prefix: prefixOf(OWN), command: "JOIN", params: [op.chan] };
    case "names": {
      const text = op.entries.map((e) => `${e.op ? "@" : ""}${e.voice ? "+" : ""}${e.nick}`).join(" ");
      return { prefix: "irc.test", command: "353", params: [OWN, "=", op.chan, text] };
    }
    case "part":
      return { prefix: prefixOf(op.nick), command: "PART", params: [op.chan] };
    case "kick":
      return { prefix: prefixOf(op.by), command: "KICK", params: [op.chan, op.target, "bye"] };
    case "quit":
      return { prefix: prefixOf(op.nick), command: "QUIT", params: ["gone"] };
    case "nick":
      return { prefix: prefixOf(op.from), command: "NICK", params: [op.to] };
    case "mode": {
      const modes = op.items.map((i) => `${i.add ? "+" : "-"}${i.flag}`).join("");
      return {
        prefix: prefixOf("Al[x]"),
        command: "MODE",
        params: [op.chan, modes, ...op.items.map((i) => i.nick)],
      };
    }
  }
}

// ---------- Reference model: list of {nick, op, voice}, linear lookup under irc_lower ----------

interface RefMember {
  nick: string;
  op: boolean;
  voice: boolean;
}
type RefModel = Map<string, RefMember[]>;

const same = (a: string, b: string): boolean => irc_lower(a) === irc_lower(b);
const find = (list: readonly RefMember[], nick: string): number => list.findIndex((m) => same(m.nick, nick));

function cloneModel(model: RefModel): RefModel {
  return new Map([...model].map(([k, v]) => [k, v.map((m) => ({ ...m }))]));
}

function applyRef(model: RefModel, op: Op): RefModel {
  const next = cloneModel(model);
  switch (op.t) {
    case "ownJoin":
      // A fresh window starts with an empty member set (own nick arrives with the 353).
      next.set(irc_lower(op.chan), []);
      break;
    case "join": {
      const list = next.get(irc_lower(op.chan));
      // JOIN of an existing member keeps its flags.
      if (list !== undefined && find(list, op.nick) === -1) list.push({ nick: op.nick, op: false, voice: false });
      break;
    }
    case "names": {
      const list = next.get(irc_lower(op.chan));
      if (list === undefined) break;
      for (const e of op.entries) {
        const i = find(list, e.nick);
        if (i === -1) list.push({ ...e });
        else list[i] = { ...e };
      }
      break;
    }
    case "part":
    case "kick": {
      const who = op.t === "part" ? op.nick : op.target;
      const ck = irc_lower(op.chan);
      const list = next.get(ck);
      if (list === undefined) break;
      if (same(who, OWN)) next.delete(ck);
      else {
        const i = find(list, who);
        if (i !== -1) list.splice(i, 1);
      }
      break;
    }
    case "quit":
      for (const list of next.values()) {
        const i = find(list, op.nick);
        if (i !== -1) list.splice(i, 1);
      }
      break;
    case "nick":
      for (const list of next.values()) {
        const i = find(list, op.from);
        if (i === -1) continue;
        const old = list[i];
        if (old === undefined) continue;
        list.splice(i, 1);
        // Collision: the renamed entry replaces an existing holder of the new nick.
        const j = find(list, op.to);
        if (j !== -1) list.splice(j, 1);
        list.push({ nick: op.to, op: old.op, voice: old.voice });
      }
      break;
    case "mode": {
      const list = next.get(irc_lower(op.chan));
      if (list === undefined) break;
      for (const item of op.items) {
        const i = find(list, item.nick);
        const m = i === -1 ? undefined : list[i];
        if (m === undefined) continue;
        if (item.flag === "o") m.op = item.add;
        else m.voice = item.add;
      }
      break;
    }
  }
  return next;
}

type Snapshot = Record<string, readonly [string, boolean, boolean]>;

function snapshotRef(list: readonly RefMember[]): Snapshot {
  return Object.fromEntries(list.map((m) => [irc_lower(m.nick), [m.nick, m.op, m.voice] as const]));
}

function snapshotState(state: ClientState, chan: string): Snapshot | undefined {
  const win = state.windows[channelKey(chan)];
  if (win === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(win.members ?? {}).map(([k, m]) => [k, [m.nick, m.op, m.voice] as const]),
  );
}

function startState(): { state: ClientState; model: RefModel } {
  let state = initialState(OWN);
  const msgs: IrcMessage[] = [
    { prefix: "irc.test", command: "001", params: [OWN, "Welcome"] },
    { prefix: prefixOf(OWN), command: "JOIN", params: ["#Dev"] },
    { prefix: "irc.test", command: "353", params: [OWN, "=", "#Dev", "@me +Al[x] bob"] },
  ];
  msgs.forEach((m, i) => {
    state = reduce(state, m, 1000 + i).state;
  });
  const model: RefModel = new Map([
    [
      irc_lower("#Dev"),
      [
        { nick: OWN, op: true, voice: false },
        { nick: "Al[x]", op: false, voice: true },
        { nick: "bob", op: false, voice: false },
      ],
    ],
  ]);
  return { state, model };
}

describe("reducer member sets", () => {
  it(
    "P2 member sets match reference model",
    () => {
      fc.assert(
        fc.property(fc.array(opArb, { maxLength: 60 }), (ops) => {
          let { state, model } = startState();
          expect(snapshotState(state, "#Dev")).toEqual(snapshotRef(model.get(irc_lower("#Dev")) ?? []));

          ops.forEach((op, i) => {
            const before = state;
            model = applyRef(model, op);
            state = reduce(state, toMessage(op), 2000 + i).state;

            for (const chan of ALL_CHANNELS) {
              const ref = model.get(irc_lower(chan));
              const actual = snapshotState(state, chan);
              if (ref === undefined) {
                expect(actual).toBeUndefined();
                continue;
              }
              expect(actual).toEqual(snapshotRef(ref));

              // No two members are equal under irc_lower, and every key is irc_lower(nick).
              const win = state.windows[channelKey(chan)];
              const members = Object.entries(win?.members ?? {});
              expect(new Set(members.map(([, m]) => irc_lower(m.nick))).size).toBe(members.length);
              for (const [k, m] of members) expect(k).toBe(irc_lower(m.nick));
            }

            // Own PART / KICK drops the member set (window) of that channel.
            if ((op.t === "part" && same(op.nick, OWN)) || (op.t === "kick" && same(op.target, OWN))) {
              if (before.windows[channelKey(op.chan)] !== undefined) {
                expect(state.windows[channelKey(op.chan)]).toBeUndefined();
              }
            }

            // MODE that targets no member leaves the member set untouched.
            if (op.t === "mode") {
              const prev = before.windows[channelKey(op.chan)]?.members;
              if (prev !== undefined && op.items.every((it) => !Object.hasOwn(prev, irc_lower(it.nick)))) {
                expect(state.windows[channelKey(op.chan)]?.members).toEqual(prev);
              }
            }
          });
        }),
        { numRuns: 200 },
      );
    },
    60_000,
  );
});
