import type { IrcMessage } from "@seance/irc-protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { initialState, reduce } from "./reducer.js";
import { openWindow } from "./reducer.route.js";
import type { ClientState } from "./types.js";

// Feature: web-client-basic, Property 19: Unread and mention flags follow the active window
// **Validates: Requirements 5.12, 10.2**

const OWN = "me";
const NICK_CHARS = "A-Za-z0-9\\-[\\]\\\\`^{|}_";
const MENTION_RE = new RegExp(`(^|[^${NICK_CHARS}])${OWN}($|[^${NICK_CHARS}])`, "i");

const CHANNEL = "#dev";
const QUERY = "bob";
const CHANNEL_KEY = "c:#dev";
const QUERY_KEY = "q:bob";
const WINDOW_KEYS = ["status", CHANNEL_KEY, QUERY_KEY] as const;
const keyFor = (target: string): string => (target === CHANNEL ? CHANNEL_KEY : QUERY_KEY);

/** Words that include the own nick as a whole word, as a substring, and unrelated text. */
const wordArb = fc.constantFrom("hello", "me", "ME", "Me", "meow", "name", "me,", "(me)", "me:", "x_me", "me-2", "ok", "");
const textArb = fc
  .array(wordArb, { minLength: 0, maxLength: 5 })
  .map((words) => words.join(" "));

const startArb = fc.constantFrom(...WINDOW_KEYS);
const targetArb = fc.constantFrom(CHANNEL, QUERY);
const commandArb = fc.constantFrom("PRIVMSG", "NOTICE");

function baseState(activeKey: string): ClientState {
  let state = initialState(OWN);
  state = openWindow(state, "channel", CHANNEL, false);
  state = openWindow(state, "query", QUERY, false);
  return { ...state, activeKey };
}

function chat(command: string, from: string, target: string, text: string): IrcMessage {
  return { prefix: `${from}!u@h`, command, params: [target, text] };
}

describe("reducer flags", () => {
  it(
    "P19 unread and mention flags follow active window",
    () => {
      fc.assert(
        fc.property(startArb, targetArb, commandArb, textArb, (active, target, command, text) => {
          const state = baseState(active);
          // Channel lines are addressed to the channel; query lines to the own nick from the query peer.
          const msg =
            target === CHANNEL
              ? chat(command, "alice", CHANNEL, text)
              : chat(command, QUERY, OWN, text);
          const after = reduce(state, msg, 1000).state;
          const win = after.windows[keyFor(target)];
          const last = win?.lines.at(-1);
          const expectMention = MENTION_RE.test(text);

          expect(last?.text).toBe(text);
          expect(last?.mention).toBe(expectMention);
          expect(last?.own).toBe(false);
          if (keyFor(target) === active) {
            expect(win?.unread).toBe(false);
            expect(win?.mentioned).toBe(false);
          } else {
            expect(win?.unread).toBe(true);
            expect(win?.mentioned).toBe(expectMention);
          }
          // Other windows keep their flags.
          for (const key of WINDOW_KEYS) {
            if (key !== keyFor(target)) {
              expect(after.windows[key]?.unread).toBe(false);
              expect(after.windows[key]?.mentioned).toBe(false);
            }
          }
        }),
        { numRuns: 200 },
      );
    },
    30_000,
  );

  it(
    "P19 own lines never carry a mention",
    () => {
      fc.assert(
        fc.property(startArb, commandArb, textArb, (active, command, text) => {
          const after = reduce(baseState(active), chat(command, OWN, CHANNEL, text), 1000).state;
          const win = after.windows[CHANNEL_KEY];
          expect(win?.lines.at(-1)?.mention).toBe(false);
          expect(win?.lines.at(-1)?.own).toBe(true);
          expect(win?.mentioned).toBe(false);
          expect(win?.unread).toBe(active !== CHANNEL_KEY);
        }),
        { numRuns: 100 },
      );
    },
    30_000,
  );
});
