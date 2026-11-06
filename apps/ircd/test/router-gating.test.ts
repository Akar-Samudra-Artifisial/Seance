import { describe, expect, it, vi } from "vitest";
import type { IrcMessage } from "@seance/irc-protocol";
import { ChannelRegistry } from "../src/channel-registry.js";
import type { Client } from "../src/client.js";
import { CommandRouter, PRE_REGISTRATION_COMMANDS } from "../src/command-router.js";
import type { RouterContext } from "../src/command-router.js";
import { ConnectionManager } from "../src/connection-manager.js";

function setup(registered: boolean) {
  const channels = new ChannelRegistry();
  const ctx: RouterContext = {
    connections: new ConnectionManager(channels.memberIdsLookup),
    channels,
    serverName: "irc.test",
    logger: { error: vi.fn() },
  };
  const sent: IrcMessage[] = [];
  const client: Client = {
    id: "1",
    registered,
    send: (m) => {
      sent.push(m);
    },
    close: () => {},
  };
  return { ctx, client, sent, router: new CommandRouter() };
}

describe("CommandRouter gating details (Req 1.5, 1.6, 3.6, 3.7)", () => {
  it("allows every pre-registration command before registration", () => {
    for (const command of PRE_REGISTRATION_COMMANDS) {
      const { ctx, client, router } = setup(false);
      const run = vi.fn();
      router.register(command, { minParams: 0, run });
      expect(router.dispatch(ctx, client, { command, params: [] })).toBe("handled");
      expect(run).toHaveBeenCalledOnce();
    }
  });

  it("gates before looking up handlers: unknown command from unregistered gets 451, not 421", () => {
    const { ctx, client, sent, router } = setup(false);
    expect(router.dispatch(ctx, client, { command: "FOO", params: [] })).toBe("not-registered");
    expect(sent.map((m) => m.command)).toEqual(["451"]);
  });

  it("uses the client's nick as target of 451 once a nick is set", () => {
    const { ctx, client, sent, router } = setup(false);
    client.nick = "bob";
    router.dispatch(ctx, client, { command: "PRIVMSG", params: ["x", "y"] });
    expect(sent[0]).toMatchObject({ prefix: "irc.test", command: "451", params: ["bob", "You have not registered"] });
  });

  it("checks params after the command is known (421 beats 461)", () => {
    const { ctx, client, sent, router } = setup(true);
    router.dispatch(ctx, client, { command: "NOPE", params: [] });
    expect(sent.map((m) => m.command)).toEqual(["421"]);
  });

  it("461 for a pre-registration command with too few params", () => {
    const { ctx, client, sent, router } = setup(false);
    router.register("NICK", { minParams: 1, run: vi.fn() });
    expect(router.dispatch(ctx, client, { command: "nick", params: [] })).toBe("need-more-params");
    expect(sent[0]).toMatchObject({ command: "461", params: ["*", "NICK", "Not enough parameters"] });
  });

  it("invokes the handler at exactly the minimum param count with an uppercased message", () => {
    const { ctx, client, sent, router } = setup(true);
    const run = vi.fn();
    router.register("TOPIC", { minParams: 1, run });
    expect(router.dispatch(ctx, client, { command: "topic", params: ["#a"] })).toBe("handled");
    expect(run).toHaveBeenCalledWith(ctx, client, { command: "TOPIC", params: ["#a"] });
    expect(sent).toHaveLength(0);
  });

  it("rejects duplicate registrations and invalid minParams", () => {
    const { router } = setup(true);
    router.register("JOIN", { minParams: 1, run: vi.fn() });
    expect(() => router.register("join", { minParams: 1, run: vi.fn() })).toThrow(/already exists/);
    expect(() => router.register("X", { minParams: -1, run: vi.fn() })).toThrow(/minParams/);
  });

  it("touches the connection on parse errors too (Req 4.3)", () => {
    const { ctx, client, router } = setup(true);
    const touch = vi.spyOn(ctx.connections, "touch");
    router.dispatch(ctx, client, { kind: "parse-error", reason: "bad" });
    expect(touch).toHaveBeenCalledWith(client);
  });
});
