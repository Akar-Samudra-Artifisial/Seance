import type { IrcMessage } from "@seance/irc-protocol";
import { describe, expect, it } from "vitest";
import { initialState, reduce } from "./reducer.js";
import { beginSilentWhois, claimSilentWhois, expireSilentWhois } from "./reducer.whois.js";
import { MAX_WHOIS_PENDING } from "./reducer.route.js";
import { resetForReconnect } from "./reset.js";
import type { ClientState } from "./types.js";

// web-client-extras R8.18: a silent WHOIS updates the credits and prints nothing.

const n = (command: string, ...params: string[]): IrcMessage => ({ prefix: "ircd.test", command, params: ["me", ...params] });
const run = (start: ClientState, msgs: readonly IrcMessage[]): ClientState =>
  msgs.reduce((s, m) => reduce(s, m, 1000).state, start);

/** Registered, with a channel window open, so a line could land in Status or #dev. */
function base(): ClientState {
  const joined = run(initialState("me"), [
    { prefix: "me!u@h", command: "JOIN", params: ["#dev"] },
    n("353", "=", "#dev", "@me coder"),
    n("366", "#dev", "End of /NAMES list"),
  ]);
  return { ...joined, phase: "registered" };
}

/** The full reply of the runner's ircd for `coder`. */
const reply = (total: string): IrcMessage[] => [
  n("311", "coder", "coder", "seance.local", "*", "coder (Séance agent)"),
  n("319", "coder", "#dev"),
  n("312", "coder", "seance.local", "Séance"),
  // Task 10.23: the counter keeps `used` per channel, so the amount under test is the channel's.
  n("320", "coder", `credits: #dev ${total} / total 9.99`),
  n("301", "coder", "running a tool"),
  n("317", "coder", "3", "1700000000"),
  n("318", "coder", "End of /WHOIS list"),
];

const lineCount = (s: ClientState): number => Object.values(s.windows).reduce((sum, w) => sum + w.lines.length, 0);

describe("silent WHOIS", () => {
  it("updates the credits and appends no line in any window, Status included", () => {
    const start = beginSilentWhois(base(), "Coder");
    const before = lineCount(start);
    const s = run(start, reply("0.03"));
    expect(s.credits["coder"]?.["#dev"]).toBe(0.03);
    expect(lineCount(s)).toBe(before);
    expect(s.silentWhois).toEqual([]);
    expect(Object.keys(s.whoisPending)).toEqual([]);
  });

  it("ends silently on 401 (the agent has quit), and keeps the error line for a normal WHOIS", () => {
    const start = beginSilentWhois(base(), "coder");
    const before = lineCount(start);
    const s = run(start, [n("401", "coder", "No such nick/channel"), n("318", "coder", "End of /WHOIS list")]);
    expect(lineCount(s)).toBe(before);
    expect(s.silentWhois).toEqual([]);

    const normal = run(base(), [n("401", "coder", "No such nick/channel")]);
    expect(lineCount(normal)).toBe(lineCount(base()) + 1);
  });

  it("prints the normal block when the user claims the silent request", () => {
    const start = claimSilentWhois(beginSilentWhois(base(), "coder"), "CODER");
    expect(start.silentWhois).toEqual([]);
    const s = run(start, reply("0.05"));
    expect(s.credits["coder"]?.["#dev"]).toBe(0.05);
    const whois = Object.values(s.windows).flatMap((w) => w.lines).filter((l) => l.kind === "whois");
    expect(whois).toHaveLength(1);
    expect(whois[0]?.whois?.away).toBe("running a tool");
  });

  it("does not record a nick twice and stays within the cap", () => {
    let s = beginSilentWhois(beginSilentWhois(base(), "coder"), "CODER");
    expect(s.silentWhois).toEqual(["coder"]);
    for (let i = 0; i < MAX_WHOIS_PENDING + 5; i++) s = beginSilentWhois(s, `a${String(i)}`);
    expect(s.silentWhois).toHaveLength(MAX_WHOIS_PENDING);
  });

  it("is cleared on reconnect", () => {
    expect(resetForReconnect(beginSilentWhois(base(), "coder")).silentWhois).toEqual([]);
    expect(resetForReconnect(expireSilentWhois(beginSilentWhois(base(), "coder"), "coder")).silentExpired).toEqual([]);
  });

  it("caps the timed-out keys and drops the oldest first (task 10.22)", () => {
    let s = base();
    for (let i = 0; i < MAX_WHOIS_PENDING + 3; i++) s = expireSilentWhois(beginSilentWhois(s, `a${String(i)}`), `a${String(i)}`);
    expect(s.silentExpired).toHaveLength(MAX_WHOIS_PENDING);
    expect(s.silentExpired[0]).toBe("a3");
    expect(s.silentWhois).toEqual([]);
  });
});
