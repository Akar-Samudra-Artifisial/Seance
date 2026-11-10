import { Numerics, isValidChannel } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import type { Client } from "../client.js";
import type { CommandRouter, RouterContext } from "../command-router.js";
import { reflectedReply } from "../replies.js";
import { isBanned } from "../ban-mask.js";
import { buildNamesReplies } from "../names.js";
import { sendTopicReply } from "../topic-reply.js";

/** Join one channel; a failure here never affects other channels (Req 5.9). */
function joinOne(ctx: RouterContext, client: Client, name: string): void {
  if (!isValidChannel(name)) {
    reflectedReply(ctx, client, Numerics.ERR_NOSUCHCHANNEL, [name], "No such channel"); // Req 5.4
    return;
  }
  const existing = ctx.channels.get(name);
  if (
    existing !== undefined &&
    !existing.members.has(client.id) &&
    isBanned(existing.bans, client.nick ?? "*", client.user ?? client.nick ?? "*", client.host ?? ctx.serverName)
  ) {
    reflectedReply(ctx, client, Numerics.ERR_BANNEDFROMCHAN, [existing.name], "Cannot join channel (+b)");
    return;
  }
  const result = ctx.channels.join(client.id, name, client.nick); // creator gets +o (Req 5.1)
  if (result.kind === "already-member") return; // silent no-op (Req 5.5)

  const { channel } = result;
  const nick = client.nick ?? "*";
  const joinMsg: IrcMessage = {
    prefix: `${nick}!${client.user ?? nick}@${client.host ?? ctx.serverName}`,
    command: "JOIN",
    params: [channel.name],
  };
  // Req 5.2: every member, including the joiner.
  for (const id of channel.members.keys()) {
    ctx.connections.get(id)?.send(joinMsg);
  }
  // Req 5.3: topic, then names.
  sendTopicReply(ctx, client, channel);
  for (const line of buildNamesReplies(ctx, client, channel)) client.send(line);
}

/** `JOIN <channel>{,<channel>}`: Req 5.1–5.5, 5.9, 5.10 (461 via minParams). */
function handleJoin(ctx: RouterContext, client: Client, msg: IrcMessage): void {
  const list = msg.params[0];
  if (list === undefined) return; // unreachable: router enforces minParams
  for (const name of list.split(",")) {
    if (name === "") continue;
    try {
      joinOne(ctx, client, name);
    } catch (error) {
      ctx.logger.error(
        { command: "JOIN", clientId: client.id, error },
        `JOIN of "${name}" failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** Register JOIN on the router. */
export function registerJoinHandler(router: CommandRouter): void {
  router.register("JOIN", { minParams: 1, run: handleJoin });
}
