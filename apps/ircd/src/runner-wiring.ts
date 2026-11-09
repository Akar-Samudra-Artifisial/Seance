import type { HostClient, IrcHost } from "@seance/runner";
import type { Client } from "./client.js";
import type { IrcServer } from "./server.js";

/** Registered clients only; unregistered connections are invisible to the runner. */
function registeredOnly(client: Client | undefined): Client | undefined {
  return client !== undefined && client.registered ? client : undefined;
}

/**
 * Adapt an `IrcServer` to the runner's structural `IrcHost` port (design D9).
 * The return type annotation makes any drift between the port and the ircd
 * shapes (`Client`, `Channel`, `VirtualClient`, `EventMap`) a typecheck error.
 */
export function createIrcHost(server: IrcServer): IrcHost {
  const { ctx } = server;

  return {
    serverName: ctx.serverName,
    createVirtualClient(options) {
      return server.createVirtualClient(options);
    },
    subscribe(name, listener) {
      return server.events.subscribe(name, listener);
    },
    clientByNick(nick): HostClient | undefined {
      return registeredOnly(ctx.connections.getByNick(nick));
    },
    clientById(id): HostClient | undefined {
      return registeredOnly(ctx.connections.get(id));
    },
    channel(name) {
      return ctx.channels.get(name);
    },
    modeOf(channel, nick) {
      const client = registeredOnly(ctx.connections.getByNick(nick));
      if (client === undefined) return undefined;
      const membership = ctx.channels.get(channel)?.members.get(client.id);
      return membership === undefined
        ? undefined
        : { op: membership.op, voice: membership.voice };
    },
    noticeTo(nick, text) {
      const client = registeredOnly(ctx.connections.getByNick(nick));
      if (client === undefined) return false;
      client.send({
        prefix: ctx.serverName,
        command: "NOTICE",
        params: [client.nick ?? nick, text],
      });
      return true;
    },
    serviceNotice(service, target, text) {
      return server.services.notice(service, target, text);
    },
    // public-hardening Requirement 3: the runner checks inviters against accounts.
    accountsEnabled: ctx.accounts !== undefined,
    accountOf(nick) {
      return registeredOnly(ctx.connections.getByNick(nick))?.account;
    },
    isAccount(nick) {
      return ctx.accounts?.has(nick) === true;
    },
  };
}
