import { Numerics } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

// Feature: ircd-agent-commands-fixes, Property 3 (exploration): Finding 3, blank AWAY text.
// Requirement 1.8. Written before the fix.

function setup() {
  const server = createServer(loadConfig({}), { error: () => {} });
  const inbox: IrcMessage[] = [];
  const alice = server.createVirtualClient({ id: "a" });
  alice.onMessage((m) => inbox.push(m));
  alice.dispatch({ command: "NICK", params: ["alice"] });
  alice.dispatch({ command: "USER", params: ["alice", "0", "*", "alice"] });
  inbox.length = 0;
  return { server, alice, inbox };
}

const BLANK: ReadonlyArray<readonly [string, string]> = [
  ["spaces", "   "],
  ["tabs", "\t\t"],
  ["mixed whitespace", " \t "],
];

describe("Finding 3: blank AWAY (exploration)", () => {
  it.each(BLANK)("1.8 AWAY with only %s replies 305 and clears away", (_label, text) => {
    const { alice, inbox } = setup();
    alice.dispatch({ command: "AWAY", params: [text] });
    expect(inbox.map((m) => m.command)).toEqual([Numerics.RPL_UNAWAY]);
    expect(alice.away).toBeUndefined();
  });

  it("1.8 AWAY with only CR/LF/NUL (bypassing wire framing) replies 305 and clears away", () => {
    const { server, alice, inbox } = setup();
    // dispatch() rejects CR/LF through serialize(); go through the router directly.
    server.router.dispatch(server.ctx, alice, { command: "AWAY", params: ["\r\n\0"] });
    expect(inbox.map((m) => m.command)).toEqual([Numerics.RPL_UNAWAY]);
    expect(alice.away).toBeUndefined();
  });

  it("1.8 blank AWAY clears a previous real away text", () => {
    const { alice, inbox } = setup();
    alice.dispatch({ command: "AWAY", params: ["gone fishing"] });
    inbox.length = 0;
    alice.dispatch({ command: "AWAY", params: ["   "] });
    expect(inbox.map((m) => m.command)).toEqual([Numerics.RPL_UNAWAY]);
    expect(alice.away).toBeUndefined();
  });

  it("1.8 VirtualClient.setAway('   ') clears away", () => {
    const { alice } = setup();
    alice.setAway("   ");
    expect(alice.away).toBeUndefined();
  });

  it("1.8 VirtualClient.setAway('\\t \\r\\n') clears away", () => {
    const { alice } = setup();
    alice.setAway("\t \r\n");
    expect(alice.away).toBeUndefined();
  });

  it("1.8 text-limits exports normalizeAway", async () => {
    const mod = (await import("../src/text-limits.js")) as Record<string, unknown>;
    const normalize = mod["normalizeAway"] as ((t: string | undefined) => string) | undefined;
    expect(normalize, "normalizeAway is not implemented yet").toBeTypeOf("function");
    expect(normalize?.("   ")).toBe("");
    expect(normalize?.("  hi  ")).toBe("hi");
    expect(normalize?.(undefined)).toBe("");
  });
});
