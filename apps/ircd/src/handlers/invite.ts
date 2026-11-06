import { Numerics, irc_lower, isValidNick } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import type { Client } from "../client.js";
import { nowMs } from "../clock.js";
import type { CommandRouter, RouterContext } from "../command-router.js";
import { awayReply, prefixOf, reflectedReply } from "../replies.js";

/**
 * Ask the resolver whether it claims an unconnected nick. Only a synchronous
 * `true` is a claim; throws, thenables and everything else are logged and
 * treated as "not claimed" (Req 6.5–6.8).
 */
function resolverClaims(
  ctx: RouterContext,
  client: Client,
  targetNick: string,
  channelName: string,
  inviterNick: string,
): boolean {
  const resolver = ctx.inviteResolver;
  if (resolver === undefined || !isValidNick(targetNick)) return false;
  try {
    const result: unknown = resolver(targetNick, channelName, inviterNick);
    if (result === true) return true;
    if (
      typeof result === "object" &&
      result !== null &&
      typeof (result as { then?: unknown }).then === "function"
    ) {
      // Defect: a Promise. Swallow a later rejection so nothing escapes unhandled.
      const thenable = result as { catch?: (onRejected: (e: unknown) => void) => unknown };
      if (typeof thenable.catch === "function") {
        thenable.catch(() => undefined);
      }
      ctx.logger.error(
        { command: "INVITE", clientId: client.id, target: targetNick },
        "INVITE resolver returned a thenable; resolvers must be synchronous",
      );
    }
    return false;
  } catch (error) {
    ctx.logger.error(
      { command: "INVITE", clientId: client.id, target: targetNick, error },
      `INVITE resolver failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/**
 * `INVITE <nick> <channel>`: Req 5.
 * Order: 403, 442, 482, 401, 443. The first failure sends exactly one error.
 */
function handleInvite(ctx: RouterContext, client: Client, msg: IrcMessage): void {
  const targetParam = msg.params[0];
  const channelParam = msg.params[1];
  if (targetParam === undefined || channelParam === undefined) return; // unreachable: minParams

  const channel = ctx.channels.get(channelParam);
  if (channel === undefined) {
    reflectedReply(ctx, client, Numerics.ERR_NOSUCHCHANNEL, [channelParam], "No such channel");
    return;
  }
  if (!channel.members.has(client.id)) {
    reflectedReply(ctx, client, Numerics.ERR_NOTONCHANNEL, [channel.name], "You're not on that channel");
    return;
  }
  if (!ctx.channels.isOp(channel.name, client.id)) {
    reflectedReply(ctx, client, Numerics.ERR_CHANOPRIVSNEEDED, [channel.name], "You're not channel operator");
    return;
  }

  const inviterNick = client.nick ?? "*";
  const found = ctx.connections.getByNick(targetParam);
  const target = found !== undefined && found.registered ? found : undefined;

  let targetNick: string;
  if (target !== undefined) {
    targetNick = target.nick ?? targetParam;
    if (channel.members.has(target.id)) {
      reflectedReply(
        ctx,
        client,
        Numerics.ERR_USERONCHANNEL,
        [targetNick, channel.name],
        "is already on channel",
      );
      return;
    }
  } else {
    if (!resolverClaims(ctx, client, targetParam, channel.name, inviterNick)) {
      reflectedReply(ctx, client, Numerics.ERR_NOSUCHNICK, [targetParam], "No such nick/channel");
      return;
    }
    targetNick = targetParam;
  }

  ctx.channels.invite(channel.name, targetNick);
  if (target !== undefined) {
    target.send({
      prefix: prefixOf(ctx, client),
      command: "INVITE",
      params: [targetNick, channel.name],
    });
  }
  client.send({
    prefix: ctx.serverName,
    command: Numerics.RPL_INVITING,
    params: [inviterNick, targetNick, channel.name],
  });
  if (target !== undefined && target.away !== undefined) {
    client.send(awayReply(ctx, client, target)); // RFC 2812 3.2.7
  }
  ctx.events?.publish("irc.invite", {
    channel: channel.name,
    inviter: inviterNick,
    target: targetNick,
    targetKey: irc_lower(targetNick),
    targetOnline: target !== undefined,
    ts: nowMs(ctx),
  });
}

/** Register INVITE on the router. */
export function registerInviteHandler(router: CommandRouter): void {
  router.register("INVITE", {
    minParams: 2, // Req 5.4
    run: (ctx, client, msg) => {
      try {
        handleInvite(ctx, client, msg);
      } catch (error) {
        ctx.logger.error(
          { command: "INVITE", clientId: client.id, error },
          `INVITE failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  });
}
