import { Numerics } from "@seance/irc-protocol";
import type { Channel } from "./channel-registry.js";
import type { Client } from "./client.js";
import type { RouterContext } from "./command-router.js";
import { clampTrailing } from "./text-limits.js";

/** Send `332 RPL_TOPIC` or `331 RPL_NOTOPIC` for the channel to the client. */
export function sendTopicReply(
  ctx: RouterContext,
  client: Client,
  channel: Channel,
): void {
  const nick = client.nick ?? "*";
  if (channel.topic !== undefined && channel.topic !== "") {
    client.send({
      prefix: ctx.serverName,
      command: Numerics.RPL_TOPIC,
      params: [
        nick,
        channel.name,
        clampTrailing(ctx.serverName, Numerics.RPL_TOPIC, [nick, channel.name], channel.topic),
      ],
    });
  } else {
    client.send({
      prefix: ctx.serverName,
      command: Numerics.RPL_NOTOPIC,
      params: [nick, channel.name, "No topic is set"],
    });
  }
}
