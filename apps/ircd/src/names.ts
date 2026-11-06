import { Numerics } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import type { Channel } from "./channel-registry.js";
import type { Client } from "./client.js";
import type { RouterContext } from "./command-router.js";
import { packEntries } from "./entry-lines.js";

/** `@` for operators, `+` for voiced members, otherwise no prefix. */
function memberEntry(nick: string, membership: { op: boolean; voice: boolean }): string {
  if (membership.op) return `@${nick}`;
  if (membership.voice) return `+${nick}`;
  return nick;
}

/**
 * Build the `353 RPL_NAMREPLY` lines for a channel, followed by one
 * `366 RPL_ENDOFNAMES` (Req 8.1, 8.3). The member list is split so every
 * serialized line is at most 512 UTF-8 bytes including CRLF, and no nick is
 * ever split across two lines. Shared by JOIN and NAMES.
 */
export function buildNamesReplies(
  ctx: RouterContext,
  client: Client,
  channel: Channel,
): readonly IrcMessage[] {
  const target = client.nick ?? "*";
  const reply = (names: string): IrcMessage => ({
    prefix: ctx.serverName,
    command: Numerics.RPL_NAMREPLY,
    params: [target, "=", channel.name, names],
  });

  const entries: string[] = [];
  for (const [id, membership] of channel.members) {
    const nick = ctx.connections.get(id)?.nick;
    if (nick !== undefined) entries.push(memberEntry(nick, membership));
  }

  return [
    ...packEntries(entries, reply),
    {
      prefix: ctx.serverName,
      command: Numerics.RPL_ENDOFNAMES,
      params: [target, channel.name, "End of /NAMES list"],
    },
  ];
}
