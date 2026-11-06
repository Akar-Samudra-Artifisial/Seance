import { Numerics } from "@seance/irc-protocol";
import type { Client } from "../client.js";
import { nowSeconds } from "../clock.js";
import type { RouterContext } from "../command-router.js";
import { awayReply, numeric, prefixOf, reflectedReply } from "../replies.js";
import { clampTrailing } from "../text-limits.js";

export type MessageCommand = "PRIVMSG" | "NOTICE";

export interface DeliverOptions {
  /**
   * When false, every error reply and the `301 RPL_AWAY` are suppressed
   * (NOTICE, Req 6.9). Delivery rules are otherwise identical.
   */
  readonly reportErrors: boolean;
}

/** Why a message was (not) delivered. */
export type DeliverResult =
  | "delivered"
  | "no-such-nick"
  | "no-such-channel"
  | "cannot-send";

/**
 * Shared PRIVMSG/NOTICE delivery path (Req 6.1–6.6, 6.10, 6.11).
 * `target` and `text` must already be validated as present and non-empty.
 */
export function deliverMessage(
  ctx: RouterContext,
  client: Client,
  command: MessageCommand,
  target: string,
  text: string,
  options: DeliverOptions,
): DeliverResult {
  const prefix = prefixOf(ctx, client);
  // A channel's canonical name differs from `target` only by case-mapped ASCII,
  // so it has the same byte length and one clamp serves both paths.
  const body = clampTrailing(prefix, command, [target], text);
  const out = {
    prefix,
    command,
    params: [target, body],
  } as const;

  if (target.startsWith("#")) {
    const channel = ctx.channels.get(target);
    if (channel === undefined) {
      if (options.reportErrors) {
        reflectedReply(ctx, client, Numerics.ERR_NOSUCHCHANNEL, [target], "No such channel");
      }
      return "no-such-channel";
    }
    if (!ctx.channels.canSpeak(channel.name, client.id)) {
      if (options.reportErrors) {
        numeric(ctx, client, Numerics.ERR_CANNOTSENDTOCHAN, channel.name, "Cannot send to channel");
      }
      return "cannot-send";
    }
    const msg = { ...out, params: [channel.name, body] };
    for (const id of [...channel.members.keys()]) {
      if (id === client.id) continue;
      ctx.connections.get(id)?.send(msg);
    }
    client.lastActivityAt = nowSeconds(ctx);
    return "delivered";
  }

  const recipient = ctx.connections.getByNick(target);
  if (recipient === undefined || !recipient.registered) {
    if (options.reportErrors) {
      reflectedReply(ctx, client, Numerics.ERR_NOSUCHNICK, [target], "No such nick/channel");
    }
    return "no-such-nick";
  }
  recipient.send(out);
  if (options.reportErrors && recipient.away !== undefined) {
    client.send(awayReply(ctx, client, recipient));
  }
  client.lastActivityAt = nowSeconds(ctx);
  return "delivered";
}
