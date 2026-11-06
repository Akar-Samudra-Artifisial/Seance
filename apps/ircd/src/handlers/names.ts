import { Numerics } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import type { Client } from "../client.js";
import type { CommandRouter, RouterContext } from "../command-router.js";
import { buildNamesReplies } from "../names.js";

function endOfNames(ctx: RouterContext, client: Client, name: string): IrcMessage {
  return {
    prefix: ctx.serverName,
    command: Numerics.RPL_ENDOFNAMES,
    params: [client.nick ?? "*", name, "End of /NAMES list"],
  };
}

function namesForChannel(ctx: RouterContext, client: Client, name: string): void {
  const channel = ctx.channels.get(name);
  if (channel === undefined || channel.members.size === 0) {
    client.send(endOfNames(ctx, client, name)); // Req 8.2
    return;
  }
  for (const reply of buildNamesReplies(ctx, client, channel)) client.send(reply); // Req 8.1, 8.3
}

/**
 * `NAMES [<ch>{,<ch>}]`: Req 8.1–8.3. With no parameter only a bare
 * `366 *` is sent; listing every channel is outside the supported subset.
 */
function handleNames(ctx: RouterContext, client: Client, msg: IrcMessage): void {
  const list = msg.params[0];
  if (list === undefined) {
    client.send(endOfNames(ctx, client, "*"));
    return;
  }
  for (const name of list.split(",")) {
    if (name === "") continue;
    try {
      namesForChannel(ctx, client, name);
    } catch (error) {
      ctx.logger.error(
        { command: "NAMES", clientId: client.id, error },
        `NAMES failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** Register NAMES on the router. */
export function registerNamesHandler(router: CommandRouter): void {
  router.register("NAMES", { minParams: 0, run: handleNames });
}
