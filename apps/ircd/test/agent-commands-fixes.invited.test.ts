import type { IrcMessage } from "@seance/irc-protocol";
import { describe, expect, it } from "vitest";
import { ChannelRegistry } from "../src/channel-registry.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import type { VirtualClient } from "../src/virtual-client.js";

// Feature: ircd-agent-commands-fixes, Property 1 (exploration): Finding 1, invited-set lifecycle.
// Requirements 1.1, 1.2, 1.3, 1.4. Written before the fix: the leak assertions must fail today.
// Invite records are seeded through ChannelRegistry.invite (an existing method) because the
// router never records an invite for a current member.

const CAP = 100;

function setup() {
  const server = createServer(loadConfig({}), { error: () => {} });
  const registry = server.ctx.channels;
  const make = (id: string, nick: string): VirtualClient => {
    const client = server.createVirtualClient({ id });
    client.onMessage((_m: IrcMessage) => {});
    client.dispatch({ command: "NICK", params: [nick] });
    client.dispatch({ command: "USER", params: [nick, "0", "*", nick] });
    return client;
  };
  return { server, registry, make };
}

const keys = (registry: ChannelRegistry, channel: string): string[] => [
  ...(registry.get(channel)?.invited ?? []),
];

describe("Finding 1: invited-set lifecycle (exploration)", () => {
  it("1.1 PART removes the leaver's entry in that channel only", () => {
    const { registry, make } = setup();
    const alice = make("a", "alice");
    const bob = make("b", "bob");
    alice.dispatch({ command: "JOIN", params: ["#a,#b"] });
    bob.dispatch({ command: "JOIN", params: ["#a"] });
    registry.invite("#a", "bob");
    registry.invite("#b", "bob");
    bob.dispatch({ command: "PART", params: ["#a"] });
    expect(registry.isInvited("#b", "bob")).toBe(true); // other channel untouched
    expect(registry.isInvited("#a", "bob")).toBe(false); // leaked entry
  });

  it("1.1 KICK removes the target's entry in that channel only", () => {
    const { registry, make } = setup();
    const alice = make("a", "alice");
    const bob = make("b", "bob");
    alice.dispatch({ command: "JOIN", params: ["#a,#b"] });
    bob.dispatch({ command: "JOIN", params: ["#a"] });
    registry.invite("#a", "bob");
    registry.invite("#b", "bob");
    alice.dispatch({ command: "KICK", params: ["#a", "bob", "bye"] });
    expect(registry.isInvited("#b", "bob")).toBe(true);
    expect(registry.isInvited("#a", "bob")).toBe(false);
  });

  it("1.2 QUIT removes the quitter's entry from every channel", () => {
    const { registry, make } = setup();
    const alice = make("a", "alice");
    const bob = make("b", "bob");
    alice.dispatch({ command: "JOIN", params: ["#a,#b"] });
    bob.dispatch({ command: "JOIN", params: ["#a"] });
    registry.invite("#a", "bob");
    registry.invite("#b", "bob");
    bob.dispatch({ command: "QUIT", params: ["gone"] });
    expect(registry.isInvited("#a", "bob")).toBe(false);
    expect(registry.isInvited("#b", "bob")).toBe(false);
  });

  it("1.3 NICK moves an invited entry; a non-invited rename adds nothing", () => {
    const { registry, make } = setup();
    const alice = make("a", "alice");
    const bob = make("b", "bob");
    const carol = make("c", "carol");
    alice.dispatch({ command: "JOIN", params: ["#a,#b,#c"] });
    registry.invite("#a", "bob");
    registry.invite("#b", "bob");
    registry.invite("#c", "zed"); // unrelated key, must survive both renames
    bob.dispatch({ command: "NICK", params: ["robert"] });
    expect.soft(keys(registry, "#a"), "#a after invited rename").toEqual(["robert"]);
    expect.soft(keys(registry, "#b"), "#b after invited rename").toEqual(["robert"]);
    // carol was never invited: her rename must not add a key (Req 2.3, last sentence).
    carol.dispatch({ command: "NICK", params: ["caroline"] });
    expect.soft(registry.isInvited("#a", "caroline"), "non-invited rename in #a").toBe(false);
    expect.soft(registry.isInvited("#b", "caroline"), "non-invited rename in #b").toBe(false);
    expect.soft(keys(registry, "#c"), "#c untouched").toEqual(["zed"]);
  });

  it("1.3 NICK onto an existing key leaves a single entry", () => {
    const { registry, make } = setup();
    const alice = make("a", "alice");
    const bob = make("b", "bob");
    alice.dispatch({ command: "JOIN", params: ["#a"] });
    registry.invite("#a", "bob");
    registry.invite("#a", "robert");
    bob.dispatch({ command: "NICK", params: ["Robert"] });
    expect(keys(registry, "#a")).toEqual(["robert"]);
  });

  it("1.3 NICK removes the new key from channels the renamer is a member of", () => {
    const { registry, make } = setup();
    const alice = make("a", "alice");
    const bob = make("b", "bob");
    alice.dispatch({ command: "JOIN", params: ["#a"] });
    bob.dispatch({ command: "JOIN", params: ["#a"] });
    registry.invite("#a", "carol"); // stale/resolver-claimed key
    bob.dispatch({ command: "NICK", params: ["carol"] });
    expect(registry.isInvited("#a", "carol")).toBe(false); // a member must not be in the set
  });

  it("1.3 ChannelRegistry exposes renameNick(clientId, oldNick, newNick)", () => {
    const registry = new ChannelRegistry();
    registry.join("op", "#t", "op");
    registry.invite("#t", "Bob");
    const rename = (registry as unknown as { renameNick?: (...a: string[]) => void }).renameNick;
    expect(rename, "renameNick is not implemented yet").toBeTypeOf("function");
    rename?.call(registry, "bobid", "Bob", "Robert");
    expect(keys(registry, "#t")).toEqual(["robert"]);
  });

  it("1.4 INVITED_MAX is exported and equals 100", async () => {
    const mod = (await import("../src/channel-registry.js")) as Record<string, unknown>;
    expect(mod["INVITED_MAX"]).toBe(CAP);
  });

  it("1.4 101 invites leave 100 and drop the oldest", () => {
    const registry = new ChannelRegistry();
    registry.join("op", "#t", "op");
    for (let i = 0; i <= CAP; i++) registry.invite("#t", `n${i}`);
    const held = keys(registry, "#t");
    expect(held.length).toBe(CAP);
    expect(held[0]).toBe("n1");
    expect(registry.isInvited("#t", "n0")).toBe(false);
  });

  it("1.4 a re-invite makes the entry newest, so it survives the next eviction", () => {
    const registry = new ChannelRegistry();
    registry.join("op", "#t", "op");
    for (let i = 0; i < CAP; i++) registry.invite("#t", `n${i}`);
    registry.invite("#t", "n0"); // n0 becomes newest
    registry.invite("#t", `n${CAP}`); // forces one eviction
    expect(registry.isInvited("#t", "n0")).toBe(true);
    expect(registry.isInvited("#t", "n1")).toBe(false);
    expect(keys(registry, "#t").length).toBe(CAP);
  });
});
