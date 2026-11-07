import type { IrcMessage } from "@seance/irc-protocol";
import { describe, expect, it } from "vitest";
import { applyFlagChanges } from "./reducer.modes.js";
import { initialState, reduce } from "./reducer.js";
import { resetForReconnect } from "./reset.js";
import type { ClientState } from "./types.js";

const m = (command: string, params: string[], prefix?: string): IrcMessage =>
  prefix === undefined ? { command, params } : { prefix, command, params };

function run(state: ClientState, ...msgs: IrcMessage[]): ClientState {
  return msgs.reduce((s, msg, i) => reduce(s, msg, 1000 + i).state, state);
}

const registered = (): ClientState =>
  run({ ...initialState(), phase: "registering" }, m("001", ["me", "Welcome"], "irc.test"));
const joined = (): ClientState => run(registered(), m("JOIN", ["#Dev"], "me!u@h"));
const modesOf = (s: ClientState): string | undefined => s.windows["c:#dev"]?.modes;

describe("applyFlagChanges", () => {
  it("adds, removes, sorts and dedupes flags", () => {
    expect(applyFlagChanges("", "+tnm")).toBe("+mnt");
    expect(applyFlagChanges("+mnt", "-m+nn")).toBe("+nt");
    expect(applyFlagChanges("+m", "-m")).toBe("");
  });

  it("excludes flags that take arguments", () => {
    expect(applyFlagChanges("", "+ovbkleIm")).toBe("+m");
  });

  it("returns the input for malformed strings", () => {
    expect(applyFlagChanges("+m", "mn")).toBe("+m");
    expect(applyFlagChanges("+m", "")).toBe("+m");
    expect(applyFlagChanges("+m", "+1!é")).toBe("+m");
  });
});

describe("channel modes", () => {
  it("324 sets modes without arguments", () => {
    const s = run(joined(), m("324", ["me", "#dev", "+tmnk", "secret"], "irc.test"));
    expect(modesOf(s)).toBe("+mnt");
  });

  it("324 with only + stores an empty string", () => {
    const s = run(joined(), m("324", ["me", "#dev", "+m"]), m("324", ["me", "#dev", "+"]));
    expect(modesOf(s)).toBe("");
  });

  it("MODE changes flags and still logs an event line", () => {
    const s = run(joined(), m("MODE", ["#dev", "+mn"], "op!u@h"), m("MODE", ["#dev", "-m"], "op!u@h"));
    expect(modesOf(s)).toBe("+n");
    expect(s.windows["c:#dev"]?.lines.at(-1)?.kind).toBe("mode");
  });

  it("MODE with member arguments changes members, not modes", () => {
    const s = run(joined(), m("JOIN", ["#dev"], "bob!u@h"), m("MODE", ["#dev", "+ov", "bob", "bob"], "op!u@h"));
    expect(modesOf(s)).toBe("");
    expect(s.windows["c:#dev"]?.members?.["bob"]?.op).toBe(true);
  });

  it("malformed 324 and MODE do not throw or change modes", () => {
    const base = run(joined(), m("324", ["me", "#dev", "+m"]));
    const s = run(base, m("324", ["me", "#dev"]), m("324", ["me", "#dev", "garbage"]), m("MODE", ["#dev", "xyz"]));
    expect(modesOf(s)).toBe("+m");
  });

  it("324 for an unknown channel is ignored", () => {
    const s = run(joined(), m("324", ["me", "#other", "+m"]));
    expect(s.windows["c:#other"]).toBeUndefined();
  });
});

describe("user modes", () => {
  it("221 sets userModes", () => {
    expect(run(registered(), m("221", ["me", "+wi"])).userModes).toBe("+iw");
  });

  it("MODE on the own nick updates userModes; other nicks are ignored", () => {
    let s = run(registered(), m("MODE", ["me", "+i"], "me!u@h"), m("MODE", ["me", "+w-i"], "me!u@h"));
    expect(s.userModes).toBe("+w");
    s = run(s, m("MODE", ["other", "+x"], "other!u@h"));
    expect(s.userModes).toBe("+w");
  });

  it("stays empty when the server reports nothing and for a malformed 221", () => {
    expect(registered().userModes).toBe("");
    expect(run(registered(), m("221", ["me"]), m("221", ["me", "wi"])).userModes).toBe("");
  });
});

describe("reconnect", () => {
  it("clears channel and user modes", () => {
    const s = run(joined(), m("324", ["me", "#dev", "+mn"]), m("221", ["me", "+i"]));
    const reset = resetForReconnect(s);
    expect(reset.userModes).toBe("");
    expect(reset.windows["c:#dev"]?.modes).toBeUndefined();
  });
});
