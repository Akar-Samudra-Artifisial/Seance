import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ChatLine, chatPrefix } from "./ChatLine.js";
import { keyOf } from "../irc/index.js";
import type { Line, Member } from "../irc/index.js";

// Feature: web-client-polish, Property 8: Chat prefix
// **Validates: Requirements 10.2**

afterEach(cleanup);

const PROTO_NAMES = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "Constructor", "__PROTO__"];

const nickArb = fc.oneof(fc.constantFrom(...PROTO_NAMES), fc.stringMatching(/^[A-Za-z][A-Za-z0-9\[\]\\_-]{0,8}$/));

const flagsArb = fc.record({ op: fc.boolean(), voice: fc.boolean() });

function expectedPrefix(flags: { readonly op: boolean; readonly voice: boolean }): string {
  return flags.op ? "@" : flags.voice ? "+" : "";
}

function renderMessage(nick: string, members: Readonly<Record<string, Member>> | undefined): string {
  const line: Line = { id: 1, at: 0, kind: "message", text: "hi", mention: false, own: false, from: nick };
  const { container, unmount } = render(<ChatLine line={line} offsetMinutes={0} members={members} />);
  const text = container.textContent ?? "";
  unmount();
  return text;
}

describe("P8 chat prefix", () => {
  it("P8 chat prefix is @ for ops, + for voiced non-ops, nothing otherwise; nick text is the display nick", () => {
    fc.assert(
      fc.property(nickArb, flagsArb, fc.boolean(), (nick, flags, plainRecord) => {
        // Null-prototype and plain records must behave the same.
        const members: Record<string, Member> = plainRecord ? {} : Object.create(null);
        Object.defineProperty(members, keyOf(nick), {
          value: { nick, ...flags },
          enumerable: true,
          writable: true,
          configurable: true,
        });
        const prefix = expectedPrefix(flags);
        expect(chatPrefix(members, nick)).toBe(prefix);
        // Case-mapped lookup finds the same member.
        expect(chatPrefix(members, nick.toUpperCase())).toBe(prefix);
        expect(renderMessage(nick, members)).toBe(`[00:00] <${prefix}${nick}> hi`);
      }),
    );
  });

  it("P8 nicks absent from members (including prototype names) get no prefix", () => {
    fc.assert(
      fc.property(nickArb, fc.boolean(), (nick, defined) => {
        const empty: Readonly<Record<string, Member>> = {};
        const other: Readonly<Record<string, Member>> = defined
          ? Object.assign(Object.create(null) as Record<string, Member>, {
              zzzzzzzzzzzz: { nick: "zzzzzzzzzzzz", op: true, voice: true },
            })
          : empty;
        for (const members of [undefined, empty, other]) {
          expect(chatPrefix(members, nick)).toBe("");
          expect(renderMessage(nick, members)).toBe(`[00:00] <${nick}> hi`);
        }
      }),
    );
  });
});
