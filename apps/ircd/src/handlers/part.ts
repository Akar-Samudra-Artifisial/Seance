import { Numerics } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import type { Client } from "../client.js";
import type { CommandRouter, RouterContext } from "../command-router.js";
import { reflectedReply } from "../replies.js";
import { clampTrailing } from "../text-limits.js";

/** Part one channel; a failure here never affects other channels (Req 5.9). */
function partOne(
  ctx: RouterContext,
  client: Client,
  name: string,
  reason: string | undefined,
): void {
  const channel = ctx.channels.get(name);
  if (channel === undefined) {
    reflectedReply(ctx, client, Numerics.ERR_NOSUCHCHANNEL, [name], "No such channel");
    return;
  }
  if (!channel.members.has(client.id)) {
    reflectedReply(ctx, client, Numerics.ERR_NOTONCHANNEL, [channel.name], "You're not on that channel"); // Req 5.6
    return;
  }

  const nick = client.nick ?? "*";
  const prefix = `${nick}!${client.user ?? nick}@${client.host ?? ctx.serverName}`;
  const partMsg: IrcMessage = {
    prefix,
    command: "PART",
    params:
      reason === undefined
        ? [channel.name]
        : [channel.name, clampTrailing(prefix, "PART", [channel.name], reason)],
  };
  // Req 5.7: broadcast to every member, including the leaver, before removal.
  for (const id of [...channel.members.keys()]) {
    ctx.connections.get(id)?.send(partMsg);
  }
  // Removes the member and deletes the channel when empty (Req 5.8).
  ctx.channels.part(client.id, channel.name);
}

/** `PART <channel>{,<channel>} [:reason]`: Req 5.6–5.10 (461 via minParams). */
function handlePart(ctx: RouterContext, client: Client, msg: IrcMessage): void {
  const list = msg.params[0];
  if (list === undefined) return; // unreachable: router enforces minParams
  const reason = msg.params[1];
  for (const name of list.split(",")) {
    if (name === "") continue;
    try {
      partOne(ctx, client, name, reason);
    } catch (error) {
      ctx.logger.error(
        { command: "PART", clientId: client.id, error },
        `PART of "${name}" failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** Register PART on the router. */
export function registerPartHandler(router: CommandRouter): void {
  router.register("PART", { minParams: 1, run: handlePart });
}
