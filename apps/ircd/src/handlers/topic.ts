import { Numerics } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import type { Client } from "../client.js";
import type { CommandRouter, RouterContext } from "../command-router.js";
import { reflectedReply } from "../replies.js";
import { TOPICLEN, clampBytes, clampTrailing } from "../text-limits.js";
import { sendTopicReply } from "../topic-reply.js";

/** `TOPIC <channel> [:text]`: Req 7.1–7.6 (461 via minParams). */
function handleTopic(ctx: RouterContext, client: Client, msg: IrcMessage): void {
  const name = msg.params[0];
  if (name === undefined) return; // unreachable: router enforces minParams
  const text = msg.params[1];

  const channel = ctx.channels.get(name);
  if (channel === undefined) {
    reflectedReply(ctx, client, Numerics.ERR_NOSUCHCHANNEL, [name], "No such channel"); // Req 7.5
    return;
  }
  if (!channel.members.has(client.id)) {
    reflectedReply(ctx, client, Numerics.ERR_NOTONCHANNEL, [channel.name], "You're not on that channel"); // Req 7.4
    return;
  }
  if (text === undefined) {
    sendTopicReply(ctx, client, channel); // Req 7.1
    return;
  }
  // Req 7.3 under `+t` (the default); any member may set the topic under `-t`.
  if (!ctx.channels.canSetTopic(channel.name, client.id)) {
    reflectedReply(ctx, client, Numerics.ERR_CHANOPRIVSNEEDED, [channel.name], "You're not channel operator");
    return;
  }

  // Req 7.2: an empty string clears the topic. Longer topics are cut to TOPICLEN
  // so what is stored is what is advertised and what later replies can carry.
  const stored = clampBytes(text, TOPICLEN);
  if (stored === "") delete channel.topic;
  else channel.topic = stored;
  const nick = client.nick ?? "*";
  const prefix = `${nick}!${client.user ?? nick}@${client.host ?? ctx.serverName}`;
  const topicMsg: IrcMessage = {
    prefix,
    command: "TOPIC",
    params: [channel.name, clampTrailing(prefix, "TOPIC", [channel.name], stored)],
  };
  for (const id of [...channel.members.keys()]) {
    ctx.connections.get(id)?.send(topicMsg);
  }
}

/** Register TOPIC on the router. */
export function registerTopicHandler(router: CommandRouter): void {
  router.register("TOPIC", {
    minParams: 1,
    run: (ctx, client, msg) => {
      try {
        handleTopic(ctx, client, msg);
      } catch (error) {
        ctx.logger.error(
          { command: "TOPIC", clientId: client.id, error },
          `TOPIC failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  });
}
