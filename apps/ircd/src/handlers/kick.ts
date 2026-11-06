import { Numerics } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import type { Client } from "../client.js";
import type { CommandRouter, RouterContext } from "../command-router.js";
import { reflectedReply } from "../replies.js";
import { KICKLEN, clampBytes, clampTrailing } from "../text-limits.js";

/**
 * `KICK <channel> <nick> [:reason]`: Req 10.1–10.7.
 * Precedence: 403, 442, 482, 441; 461 via minParams (fewer than two params).
 * Nothing is mutated until every check has passed.
 */
function handleKick(ctx: RouterContext, client: Client, msg: IrcMessage): void {
  const name = msg.params[0];
  const targetNick = msg.params[1];
  if (name === undefined || targetNick === undefined) return; // unreachable: minParams

  const channel = ctx.channels.get(name);
  if (channel === undefined) {
    reflectedReply(ctx, client, Numerics.ERR_NOSUCHCHANNEL, [name], "No such channel"); // Req 10.5
    return;
  }
  if (!channel.members.has(client.id)) {
    reflectedReply(ctx, client, Numerics.ERR_NOTONCHANNEL, [channel.name], "You're not on that channel"); // Req 10.6
    return;
  }
  if (!ctx.channels.isOp(channel.name, client.id)) {
    reflectedReply(ctx, client, Numerics.ERR_CHANOPRIVSNEEDED, [channel.name], "You're not channel operator"); // Req 10.2
    return;
  }
  const target = ctx.connections.getByNick(targetNick);
  if (target === undefined || !channel.members.has(target.id)) {
    reflectedReply(
      ctx,
      client,
      Numerics.ERR_USERNOTINCHANNEL,
      [targetNick, channel.name],
      "They aren't on that channel",
    ); // Req 10.3
    return;
  }

  const kickerNick = client.nick ?? "*";
  const reasonParam = msg.params[2];
  const targetName = target.nick ?? targetNick;
  const prefix = `${kickerNick}!${client.user ?? kickerNick}@${client.host ?? ctx.serverName}`;
  const rawReason = reasonParam === undefined || reasonParam === "" ? kickerNick : reasonParam; // Req 10.1
  const reason = clampTrailing(
    prefix,
    "KICK",
    [channel.name, targetName],
    clampBytes(rawReason, KICKLEN),
  );
  const kickMsg: IrcMessage = {
    prefix,
    command: "KICK",
    params: [channel.name, targetName, reason],
  };
  // Req 10.1: broadcast to every member, including the target, before removal.
  for (const id of [...channel.members.keys()]) {
    ctx.connections.get(id)?.send(kickMsg);
  }
  // Removes the target and deletes the channel when empty.
  ctx.channels.part(target.id, channel.name);
  // Req 10.4: let the runner cancel the target's session.
  ctx.events?.publish("irc.kick", {
    channel: channel.name,
    by: kickerNick,
    target: targetName,
    reason,
  });
}

/** Register KICK on the router. */
export function registerKickHandler(router: CommandRouter): void {
  router.register("KICK", {
    minParams: 2, // Req 10.7
    run: (ctx, client, msg) => {
      try {
        handleKick(ctx, client, msg);
      } catch (error) {
        ctx.logger.error(
          { command: "KICK", clientId: client.id, error },
          `KICK failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  });
}
