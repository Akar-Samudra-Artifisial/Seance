// runner-services Requirement 8: ChanServ / NickServ notices in the web client, and Property 6.
import type { IrcMessage } from "@seance/irc-protocol";
import { SERVICE_NICKS } from "@seance/irc-protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { initialState, reduce } from "./reducer.js";
import type { ClientState } from "./types.js";

const m = (prefix: string, command: string, ...params: string[]): IrcMessage => ({ prefix, command, params });

function registered(nick = "bayu"): ClientState {
  return [m("seance.local", "001", nick, "Welcome"), m(`${nick}!u@h`, "JOIN", "#dev")].reduce(
    (s, msg) => reduce(s, msg, 1000).state,
    { ...initialState(nick), phase: "registering" } as ClientState,
  );
}

const run = (s: ClientState, ...msgs: IrcMessage[]): ClientState => msgs.reduce((acc, msg) => reduce(acc, msg, 2000).state, s);

describe("service notices (Req 8)", () => {
  // Before Req 8 the query branch of onChat opened `q:nickserv` for this notice.
  it("a NickServ notice to the own nick lands in Status and opens no query window", () => {
    const before = registered();
    const after = run(before, m("NickServ!NickServ@services.seance.local", "NOTICE", "bayu", "agents online: coder (idle)"));
    expect(after.order).toEqual(before.order);
    expect(after.windows["q:nickserv"]).toBeUndefined();
    const line = after.windows["status"]?.lines.at(-1);
    expect(line).toMatchObject({ kind: "notice", from: "NickServ", text: "agents online: coder (idle)" });
  });

  it("renders a ChanServ notice in the channel through the existing channel path", () => {
    const after = run(registered(), m("ChanServ!ChanServ@services.seance.local", "NOTICE", "#dev", "worktree ready: workspaces/dev @ a1b2c3d"));
    expect(after.windows["c:#dev"]?.lines.at(-1)).toMatchObject({ kind: "notice", from: "ChanServ" });
  });

  it("keeps the old behaviour for a PRIVMSG from a service nick", () => {
    const after = run(registered(), m("NickServ!NickServ@services.seance.local", "PRIVMSG", "bayu", "hello"));
    expect(after.windows["q:nickserv"]).toBeDefined();
  });

  it("P6 service notice never opens a query", () => {
    const variant = fc.constantFrom(...SERVICE_NICKS).chain((s) =>
      fc.array(fc.boolean(), { minLength: s.length, maxLength: s.length }).map((flags) =>
        [...s].map((ch, i) => (flags[i] === true ? ch.toUpperCase() : ch.toLowerCase())).join(""),
      ),
    );
    const own = fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/).filter((n) => !["chanserv", "nickserv"].includes(n));
    fc.assert(
      fc.property(variant, fc.string({ minLength: 1, maxLength: 80 }).filter((t) => t.trim() !== ""), own, (svc, text, nick) => {
        const before = registered(nick);
        const after = run(before, m(`${svc}!${svc}@services.seance.local`, "NOTICE", nick.toUpperCase(), text));
        expect(after.order).toEqual(before.order);
        expect(Object.keys(after.windows).filter((k) => k.startsWith("q:"))).toEqual([]);
        const added = (after.windows["status"]?.lines.length ?? 0) - (before.windows["status"]?.lines.length ?? 0);
        // One line, unless the text has nothing visible (the R9.2 empty-line gate drops it).
        expect(added).toBeLessThanOrEqual(1);
        if (added === 1) expect(after.windows["status"]?.lines.at(-1)?.from).toBe(svc);
      }),
      { numRuns: 200 },
    );
  });
});
