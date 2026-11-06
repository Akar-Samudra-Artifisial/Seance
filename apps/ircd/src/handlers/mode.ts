import { Numerics } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import type { Channel } from "../channel-registry.js";
import type { Client } from "../client.js";
import type { CommandRouter, RouterContext } from "../command-router.js";
import { reflectedReply } from "../replies.js";
import type { IrcModeEvent } from "../event-bus.js";

/** One validated mode change, ready to apply. */
type ModeChange = {
  readonly mode: "o" | "v" | "m";
  readonly adding: boolean;
  /** Target member id and nick (as stored by the server) for `o`/`v`. */
  readonly target?: { readonly id: string; readonly nick: string };
};

function numeric(
  ctx: RouterContext,
  client: Client,
  code: string,
  ...rest: readonly string[]
): void {
  client.send({
    prefix: ctx.serverName,
    command: code,
    params: [client.nick ?? "*", ...rest],
  });
}

function prefixOf(ctx: RouterContext, client: Client): string {
  const nick = client.nick ?? "*";
  return `${nick}!${client.user ?? nick}@${client.host ?? ctx.serverName}`;
}

/**
 * Parse and validate the whole mode string against the channel without
 * mutating anything (Req 9.5–9.9). Returns the changes, or null after having
 * sent the error reply.
 */
function validateChanges(
  ctx: RouterContext,
  client: Client,
  channel: Channel,
  modeString: string,
  args: readonly string[],
): readonly ModeChange[] | null {
  const changes: ModeChange[] = [];
  let adding = true;
  let argIndex = 0;

  for (const ch of modeString) {
    if (ch === "+") {
      adding = true;
      continue;
    }
    if (ch === "-") {
      adding = false;
      continue;
    }
    if (ch === "m") {
      changes.push({ mode: "m", adding });
      continue;
    }
    if (ch !== "o" && ch !== "v") {
      numeric(ctx, client, Numerics.ERR_UNKNOWNMODE, ch, "is unknown mode char to me"); // Req 9.8
      return null;
    }
    const nick = args[argIndex];
    argIndex += 1;
    if (nick === undefined) {
      numeric(ctx, client, Numerics.ERR_NEEDMOREPARAMS, "MODE", "Not enough parameters"); // Req 9.7
      return null;
    }
    const target = ctx.connections.getByNick(nick);
    if (target === undefined || !channel.members.has(target.id)) {
      reflectedReply(ctx, client, Numerics.ERR_USERNOTINCHANNEL, [nick, channel.name], "They aren't on that channel"); // Req 9.9
      return null;
    }
    changes.push({ mode: ch, adding, target: { id: target.id, nick: target.nick ?? nick } });
  }
  return changes;
}

/** `MODE <channel> [<modes> [<nick>...]]`: Req 9.1–9.10 (461 for bare MODE via minParams). */
function handleMode(ctx: RouterContext, client: Client, msg: IrcMessage): void {
  const name = msg.params[0];
  if (name === undefined) return; // unreachable: router enforces minParams
  const modeString = msg.params[1];

  const channel = ctx.channels.get(name);
  if (channel === undefined) {
    reflectedReply(ctx, client, Numerics.ERR_NOSUCHCHANNEL, [name], "No such channel"); // Req 9.5
    return;
  }

  if (modeString === undefined) {
    // Req 9.4: query active channel modes.
    if (!channel.members.has(client.id)) {
      reflectedReply(ctx, client, Numerics.ERR_NOTONCHANNEL, [channel.name], "You're not on that channel");
      return;
    }
    numeric(ctx, client, Numerics.RPL_CHANNELMODEIS, channel.name, channel.modes.moderated ? "+m" : "+");
    return;
  }

  if (!ctx.channels.isOp(channel.name, client.id)) {
    reflectedReply(ctx, client, Numerics.ERR_CHANOPRIVSNEEDED, [channel.name], "You're not channel operator"); // Req 9.6
    return;
  }

  const changes = validateChanges(ctx, client, channel, modeString, msg.params.slice(2));
  if (changes === null) return; // rejected: no state was touched

  const origin = prefixOf(ctx, client);
  const recipients = [...channel.members.keys()];
  for (const change of changes) {
    if (change.mode === "m") {
      channel.modes.moderated = change.adding;
    } else if (change.target !== undefined) {
      const membership = channel.members.get(change.target.id);
      if (membership === undefined) continue; // validated above; defensive
      if (change.mode === "o") membership.op = change.adding;
      else membership.voice = change.adding;
    }

    const sign = change.adding ? "+" : "-";
    const params =
      change.target === undefined
        ? [channel.name, `${sign}${change.mode}`]
        : [channel.name, `${sign}${change.mode}`, change.target.nick];
    const out: IrcMessage = { prefix: origin, command: "MODE", params };
    for (const id of recipients) ctx.connections.get(id)?.send(out);

    const event: IrcModeEvent = {
      channel: channel.name,
      by: client.nick ?? "*",
      mode: change.mode,
      adding: change.adding,
      ...(change.target === undefined ? {} : { target: change.target.nick }),
    };
    ctx.events?.publish("irc.mode", event); // Req 9.10
  }
}

/** Register MODE on the router. */
export function registerModeHandler(router: CommandRouter): void {
  router.register("MODE", {
    minParams: 1,
    run: (ctx, client, msg) => {
      try {
        handleMode(ctx, client, msg);
      } catch (error) {
        ctx.logger.error(
          { command: "MODE", clientId: client.id, error },
          `MODE failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  });
}
