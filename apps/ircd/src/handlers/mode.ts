import { Numerics, serialize } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import type { Channel } from "../channel-registry.js";
import type { Client } from "../client.js";
import type { CommandRouter, RouterContext } from "../command-router.js";
import { reflectedReply } from "../replies.js";
import type { IrcModeEvent } from "../event-bus.js";
import { BANS_MAX, normalizeBanMask } from "../ban-mask.js";

/** Channel flags without an argument: `m` moderated, `n` no external messages, `t` topic lock. */
type FlagMode = "m" | "n" | "t";
type ChannelModeChar = "o" | "v" | "b" | FlagMode;

/** One validated mode change, ready to apply. */
type ModeChange = {
  readonly mode: ChannelModeChar;
  readonly adding: boolean;
  /** Target member id and nick (as stored by the server) for `o`/`v`. */
  readonly target?: { readonly id: string; readonly nick: string };
  /** Normalised ban mask for `b`. */
  readonly mask?: string;
};

const FLAG_FIELD: Readonly<Record<FlagMode, "moderated" | "noExternal" | "topicLock">> = {
  m: "moderated",
  n: "noExternal",
  t: "topicLock",
};

const isFlag = (ch: string): ch is FlagMode => ch === "m" || ch === "n" || ch === "t";

/** `+` and the active flags in alphabetical order, e.g. `+nt` or `+mnt` (324 RPL_CHANNELMODEIS). */
export function flagString(modes: Channel["modes"]): string {
  return `+${(["m", "n", "t"] as const).filter((f) => modes[FLAG_FIELD[f]]).join("")}`;
}

/**
 * MODE parameters after the channel for a list of applied changes: sign runs over the
 * mode characters in input order, then the arguments in the same order.
 * `[{o,+,bob},{v,-,eve}]` gives `["+o-v", "bob", "eve"]`; `[{m,+},{n,+}]` gives `["+mn"]`.
 */
export function groupChanges(
  changes: readonly { readonly mode: ChannelModeChar; readonly adding: boolean; readonly nick?: string }[],
): readonly string[] {
  let modes = "";
  let sign: "+" | "-" | "" = "";
  const args: string[] = [];
  for (const c of changes) {
    const s = c.adding ? "+" : "-";
    if (s !== sign) {
      modes += s;
      sign = s;
    }
    modes += c.mode;
    if (c.nick !== undefined) args.push(c.nick);
  }
  return modes === "" ? [] : [modes, ...args];
}

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
    if (isFlag(ch)) {
      changes.push({ mode: ch, adding });
      continue;
    }
    if (ch !== "o" && ch !== "v" && ch !== "b") {
      numeric(ctx, client, Numerics.ERR_UNKNOWNMODE, ch, "is unknown mode char to me"); // Req 9.8
      return null;
    }
    const nick = args[argIndex];
    argIndex += 1;
    if (nick === undefined) {
      numeric(ctx, client, Numerics.ERR_NEEDMOREPARAMS, "MODE", "Not enough parameters"); // Req 9.7
      return null;
    }
    if (ch === "b") {
      // public-hardening follow-up (audit 10.11): `+b <nick|mask>` keeps a nick out of the channel and
      // away from INVITE; the runner mirrors it into its ban list.
      const mask = normalizeBanMask(nick);
      if (mask === undefined) {
        // No standard numeric fits an invalid mask (461 is for a missing parameter): say so in a NOTICE.
        // eslint-disable-next-line no-control-regex
        const shown = nick.replace(/[\x00-\x1f\x7f]/g, "?").slice(0, 60);
        client.send({
          prefix: ctx.serverName,
          command: "NOTICE",
          params: [client.nick ?? "*", `Invalid ban mask "${shown}": use nick, nick!user@host or user@host (at most 100 characters, no spaces)`],
        });
        return null;
      }
      changes.push({ mode: "b", adding, mask });
      continue;
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

/**
 * The broadcast for `applied`: one message, unless the sender's prefix would push it past the
 * 512-byte line limit; then it is split in halves until every part fits.
 */
function groupedMessages(prefix: string, channel: string, applied: readonly ModeChange[]): readonly IrcMessage[] {
  const msg: IrcMessage = {
    prefix,
    command: "MODE",
    params: [
      channel,
      ...groupChanges(
        applied.map((c) => ({
          mode: c.mode,
          adding: c.adding,
          ...(c.target !== undefined ? { nick: c.target.nick } : c.mask !== undefined ? { nick: c.mask } : {}),
        })),
      ),
    ],
  };
  try {
    serialize(msg);
    return [msg];
  } catch (error) {
    if (applied.length <= 1) throw error;
    const half = Math.ceil(applied.length / 2);
    return [...groupedMessages(prefix, channel, applied.slice(0, half)), ...groupedMessages(prefix, channel, applied.slice(half))];
  }
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
    numeric(ctx, client, Numerics.RPL_CHANNELMODEIS, channel.name, flagString(channel.modes));
    return;
  }

  // `MODE <channel> b` asks for the ban list (367 per mask, then 368); any member may ask.
  if (/^\+?b$/.test(modeString) && msg.params.length === 2) {
    if (!channel.members.has(client.id)) {
      reflectedReply(ctx, client, Numerics.ERR_NOTONCHANNEL, [channel.name], "You're not on that channel");
      return;
    }
    for (const mask of channel.bans) numeric(ctx, client, Numerics.RPL_BANLIST, channel.name, mask);
    numeric(ctx, client, Numerics.RPL_ENDOFBANLIST, channel.name, "End of channel ban list");
    return;
  }

  if (!ctx.channels.isOp(channel.name, client.id)) {
    reflectedReply(ctx, client, Numerics.ERR_CHANOPRIVSNEEDED, [channel.name], "You're not channel operator"); // Req 9.6
    return;
  }

  const changes = validateChanges(ctx, client, channel, modeString, msg.params.slice(2));
  if (changes === null) return; // rejected: no state was touched

  // Apply in order; keep only the changes that altered state (R12.5).
  const applied: ModeChange[] = [];
  for (const change of changes) {
    if (isFlag(change.mode)) {
      const field = FLAG_FIELD[change.mode];
      if (channel.modes[field] === change.adding) continue;
      channel.modes[field] = change.adding;
      applied.push(change);
    } else if (change.mode === "b" && change.mask !== undefined) {
      if (change.adding) {
        if (channel.bans.has(change.mask)) continue; // a duplicate stays silent
        if (channel.bans.size >= BANS_MAX) {
          numeric(ctx, client, Numerics.ERR_BANLISTFULL, channel.name, change.mask, "Channel ban list is full");
          continue;
        }
        channel.bans.add(change.mask);
      } else if (!channel.bans.delete(change.mask)) {
        continue;
      }
      applied.push(change);
    } else if (change.target !== undefined) {
      const membership = channel.members.get(change.target.id);
      if (membership === undefined) continue; // validated above; defensive
      const key = change.mode === "o" ? "op" : "voice";
      if (membership[key] === change.adding) continue;
      membership[key] = change.adding;
      applied.push(change);
    }
  }
  if (applied.length === 0) return;

  // One MODE message per command, e.g. `MODE #c +mnt` or `MODE #c +o-v coder bob`.
  const recipients = [...channel.members.keys()];
  for (const out of groupedMessages(prefixOf(ctx, client), channel.name, applied)) {
    for (const id of recipients) ctx.connections.get(id)?.send(out);
  }

  // Req 9.10: the runner port knows o, v and m only; n and t publish no event.
  for (const change of applied) {
    if (change.mode !== "o" && change.mode !== "v" && change.mode !== "m" && change.mode !== "b") continue;
    const eventTarget = change.target?.nick ?? change.mask;
    const event: IrcModeEvent = {
      channel: channel.name,
      by: client.nick ?? "*",
      mode: change.mode,
      adding: change.adding,
      ...(eventTarget === undefined ? {} : { target: eventTarget }),
    };
    ctx.events?.publish("irc.mode", event);
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
