import { Numerics } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import type { Channel } from "../channel-registry.js";
import type { Client } from "../client.js";
import type { CommandRouter, RouterContext } from "../command-router.js";
import { clampTrailing } from "../text-limits.js";

function listEntry(ctx: RouterContext, client: Client, channel: Channel): IrcMessage {
  return {
    prefix: ctx.serverName,
    command: Numerics.RPL_LIST,
    params: [
      client.nick ?? "*",
      channel.name,
      String(channel.members.size),
      clampTrailing(
        ctx.serverName,
        Numerics.RPL_LIST,
        [client.nick ?? "*", channel.name, String(channel.members.size)],
        channel.topic ?? "",
      ),
    ],
  };
}

/**
 * `LIST [<ch>{,<ch>}]`: Req 8.4, 8.5. Every channel is visible in this subset.
 * With a parameter only the listed channels that exist are reported.
 */
function handleList(ctx: RouterContext, client: Client, msg: IrcMessage): void {
  const filter = msg.params[0];
  let channels: readonly Channel[];
  if (filter === undefined) {
    channels = ctx.channels.list();
  } else {
    const found: Channel[] = [];
    for (const name of filter.split(",")) {
      const channel = name === "" ? undefined : ctx.channels.get(name);
      if (channel !== undefined && !found.includes(channel)) found.push(channel);
    }
    channels = found;
  }

  for (const channel of channels) {
    try {
      client.send(listEntry(ctx, client, channel));
    } catch (error) {
      ctx.logger.error(
        { command: "LIST", clientId: client.id, channel: channel.name, error },
        `LIST failed for ${channel.name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  client.send({
    prefix: ctx.serverName,
    command: Numerics.RPL_LISTEND,
    params: [client.nick ?? "*", "End of /LIST"],
  });
}

/** Register LIST on the router. */
export function registerListHandler(router: CommandRouter): void {
  router.register("LIST", { minParams: 0, run: handleList });
}
