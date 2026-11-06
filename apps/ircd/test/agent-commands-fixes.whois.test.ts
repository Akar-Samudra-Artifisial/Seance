import { Numerics } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

// Feature: ircd-agent-commands-fixes, Property 2 (exploration): Finding 2, WHOIS extra lines.
// Requirements 1.5, 1.6, 1.7. Written before the fix.

type Extra = () => readonly string[];
type Logged = { readonly fields: Record<string, unknown>; readonly message: string };

function run(whoisExtra: unknown, prepare?: (target: unknown) => void) {
  const logged: Logged[] = [];
  const error = vi.fn((fields: Record<string, unknown>, message: string) => {
    logged.push({ fields, message });
  });
  const server = createServer(loadConfig({}), { error });
  const inbox: IrcMessage[] = [];
  const alice = server.createVirtualClient({ id: "a" });
  alice.onMessage((m) => inbox.push(m));
  alice.dispatch({ command: "NICK", params: ["alice"] });
  alice.dispatch({ command: "USER", params: ["alice", "0", "*", "alice"] });
  const bob = server.createVirtualClient({ id: "b", whoisExtra: whoisExtra as Extra });
  bob.dispatch({ command: "NICK", params: ["bob"] });
  bob.dispatch({ command: "USER", params: ["bob", "0", "*", "bob"] });
  prepare?.(bob);
  inbox.length = 0;
  alice.dispatch({ command: "WHOIS", params: ["bob"] });
  const codes = inbox.map((m) => m.command);
  const extras = inbox
    .filter((m) => m.command === Numerics.RPL_WHOISSPECIAL)
    .map((m) => m.params[2]);
  return { inbox, codes, extras, logged };
}

const strings25 = Array.from({ length: 25 }, (_, i) => `line ${i}`);

/** Assert the full expected WHOIS outcome; soft so every broken property is reported. */
function expectTerminated(codes: readonly string[]): void {
  expect.soft(codes.filter((c) => c === Numerics.RPL_ENDOFWHOIS), "318 count").toHaveLength(1);
  expect.soft(codes.at(-1), "last reply").toBe(Numerics.RPL_ENDOFWHOIS);
}

function expectTypeLogged(logged: readonly Logged[], type: string): void {
  const hit = logged.find((l) => l.fields["valueType"] === type);
  expect
    .soft(hit, `no log with valueType=${type}; got ${JSON.stringify(logged.map((l) => l.message))}`)
    .toBeDefined();
  expect.soft(hit?.fields["command"]).toBe("WHOIS");
  expect.soft(hit?.fields["clientId"]).toBe("a");
  expect.soft(hit?.fields["targetId"]).toBe("b");
}

const NON_ARRAY: ReadonlyArray<readonly [string, unknown, string]> = [
  ["undefined", () => undefined, "undefined"],
  ["a string", () => "abc", "string"],
  ["an object", () => ({ a: 1 }), "object"],
];

// A plain throwing whoisExtra is already handled today (guarded in extraLines) and is
// covered by whois.test.ts "logs a throwing whoisExtra ... including 318"; the failing
// throw case for 1.7 is the throw after 312 below.
describe("Finding 2: WHOIS extra lines (exploration)", () => {
  it.each(NON_ARRAY)(
    "1.5 whoisExtra returning %s: no 320, one 318 last, value type logged",
    (_label, fn, type) => {
      const { codes, extras, logged } = run(fn);
      expect.soft(extras, "320 lines").toEqual([]);
      expectTerminated(codes);
      expectTypeLogged(logged, type);
    },
  );

  it("1.5 mixed array [1, 'a']: the non-string is skipped, 'a' kept, one log, one 318 last", () => {
    const { codes, extras, logged } = run(() => [1, "a"]);
    expect.soft(extras).toEqual(["a"]);
    expectTerminated(codes);
    expect
      .soft(logged.filter((l) => l.fields["command"] === "WHOIS" && l.fields["problems"] !== undefined))
      .toHaveLength(1);
  });

  it("1.6 25 strings give exactly 10 320 lines, the first 10 in order, one 318 last", () => {
    const { codes, extras } = run(() => strings25);
    expect.soft(extras).toEqual(strings25.slice(0, 10));
    expectTerminated(codes);
  });

  it("1.7 a throw after 312 still ends with one 318 and keeps the earlier replies", () => {
    const { codes, logged } = run(
      () => ["extra"],
      (target) => {
        // Reading `away` happens after the 320 lines are built and 312 is queued.
        Object.defineProperty(target, "away", {
          configurable: true,
          get() {
            throw new Error("away getter failed");
          },
        });
      },
    );
    expect(codes.filter((c) => c === Numerics.RPL_ENDOFWHOIS)).toHaveLength(1);
    expect(codes.at(-1)).toBe(Numerics.RPL_ENDOFWHOIS);
    expect(codes).toContain(Numerics.RPL_WHOISSERVER); // built before the failure
    expect(logged.some((l) => l.fields["command"] === "WHOIS")).toBe(true);
  });

  it("1.5 whois.ts exports a pure sanitizeWhoisExtra and WHOIS_EXTRA_MAX", async () => {
    const mod = (await import("../src/handlers/whois.js")) as Record<string, unknown>;
    const sanitize = mod["sanitizeWhoisExtra"] as
      | ((v: unknown) => { lines: string[]; problems: string[] })
      | undefined;
    expect(sanitize, "sanitizeWhoisExtra is not implemented yet").toBeTypeOf("function");
    expect(mod["WHOIS_EXTRA_MAX"]).toBe(10);
    expect(sanitize?.(undefined).lines).toEqual([]);
    expect(sanitize?.(undefined).problems).toHaveLength(1);
    expect(sanitize?.([1, "a"]).lines).toEqual(["a"]);
    expect(sanitize?.(strings25).lines).toEqual(strings25.slice(0, 10));
  });
});
