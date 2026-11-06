import { describe, expect, it, vi } from "vitest";
import type { IrcMessage } from "@seance/irc-protocol";
import { ChannelRegistry } from "../src/channel-registry.js";
import type { Client } from "../src/client.js";
import { CommandRouter } from "../src/command-router.js";
import type { RouterContext } from "../src/command-router.js";
import { ConnectionManager } from "../src/connection-manager.js";

function setup() {
  const channels = new ChannelRegistry();
  const error = vi.fn();
  const ctx: RouterContext = {
    connections: new ConnectionManager(channels.memberIdsLookup),
    channels,
    serverName: "irc.test",
    logger: { error },
  };
  const sent: IrcMessage[] = [];
  const client: Client = {
    id: "1",
    registered: false,
    send: (m) => {
      sent.push(m);
    },
    close: () => {},
  };
  return { ctx, client, sent, error, router: new CommandRouter() };
}

describe("CommandRouter", () => {
  it("replies 451 to unregistered clients using gated commands", () => {
    const { ctx, client, sent, router } = setup();
    const run = vi.fn();
    router.register("JOIN", { minParams: 1, run });
    expect(router.dispatch(ctx, client, { command: "JOIN", params: ["#a"] })).toBe("not-registered");
    expect(run).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ command: "451", params: ["*", "You have not registered"] });
  });

  it("lets unregistered clients use pre-registration commands", () => {
    const { ctx, client, router } = setup();
    const run = vi.fn();
    router.register("nick", { minParams: 1, run });
    expect(router.dispatch(ctx, client, { command: "NICK", params: ["a"] })).toBe("handled");
    expect(run).toHaveBeenCalledOnce();
  });

  it("replies 421 for unknown commands from registered clients", () => {
    const { ctx, client, sent, router } = setup();
    client.registered = true;
    client.nick = "bob";
    expect(router.dispatch(ctx, client, { command: "FOO", params: [] })).toBe("unknown-command");
    expect(sent[0]).toMatchObject({ command: "421", params: ["bob", "FOO", "Unknown command"] });
  });

  it("replies 461 when below the declared minimum params", () => {
    const { ctx, client, sent, router } = setup();
    client.registered = true;
    const run = vi.fn();
    router.register("KICK", { minParams: 2, run });
    expect(router.dispatch(ctx, client, { command: "KICK", params: ["#a"] })).toBe("need-more-params");
    expect(run).not.toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ command: "461", params: ["*", "KICK", "Not enough parameters"] });
  });

  it("matches lower-case input commands", () => {
    const { ctx, client, router } = setup();
    client.registered = true;
    const run = vi.fn();
    router.register("PING", { minParams: 0, run });
    router.dispatch(ctx, client, { command: "ping", params: [] });
    expect(run).toHaveBeenCalledOnce();
  });

  it("contains handler exceptions and logs command and client id", () => {
    const { ctx, client, error, router } = setup();
    client.registered = true;
    router.register("BOOM", {
      minParams: 0,
      run: () => {
        throw new Error("kaput");
      },
    });
    expect(router.dispatch(ctx, client, { command: "BOOM", params: [] })).toBe("handler-error");
    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0]?.[0]).toMatchObject({ command: "BOOM", clientId: "1" });
  });

  it("drops parse errors silently", () => {
    const { ctx, client, sent, router } = setup();
    expect(router.dispatch(ctx, client, { kind: "parse-error", reason: "bad" })).toBe("dropped");
    expect(sent).toHaveLength(0);
    expect(router.dropped).toBe(1);
  });
});
