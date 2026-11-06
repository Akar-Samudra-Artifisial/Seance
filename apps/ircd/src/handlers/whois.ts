import { Numerics } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import type { Client } from "../client.js";
import { nowSeconds } from "../clock.js";
import type { CommandRouter, RouterContext } from "../command-router.js";
import { packEntries } from "../entry-lines.js";
import { awayReply, numeric, reflectedReply } from "../replies.js";
import { clampTrailing, stripControl } from "../text-limits.js";

/** Description sent in `312`. */
const SERVER_INFO = "Séance IRC server";

/** Build the `320` lines from `whoisExtra()`; a throwing callback is logged and skipped. */
function extraLines(ctx: RouterContext, client: Client, target: Client): readonly string[] {
  if (target.whoisExtra === undefined) return [];
  try {
    return target.whoisExtra();
  } catch (error) {
    ctx.logger.error(
      { command: "WHOIS", clientId: client.id, targetId: target.id, error },
      `WHOIS extra info failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

/** Replies for a registered target, in Req 2.1 / 3.2 order. */
function buildWhoisReplies(
  ctx: RouterContext,
  to: Client,
  target: Client,
): readonly IrcMessage[] {
  const me = to.nick ?? "*";
  const nick = target.nick ?? "*";
  const user = target.user ?? nick;
  const host = target.host ?? ctx.serverName;
  const server = ctx.serverName;
  const out: IrcMessage[] = [];

  out.push({
    prefix: server,
    command: Numerics.RPL_WHOISUSER,
    params: [
      me,
      nick,
      user,
      host,
      "*",
      clampTrailing(server, Numerics.RPL_WHOISUSER, [me, nick, user, host, "*"], target.realname ?? nick),
    ],
  });

  const entries = ctx.channels.channelsOf(target.id).map((channel) => {
    const membership = channel.members.get(target.id);
    const prefix = membership?.op === true ? "@" : membership?.voice === true ? "+" : "";
    return `${prefix}${channel.name}`;
  });
  out.push(
    ...packEntries(entries, (joined) => ({
      prefix: server,
      command: Numerics.RPL_WHOISCHANNELS,
      params: [me, nick, joined],
    })),
  );

  out.push({
    prefix: server,
    command: Numerics.RPL_WHOISSERVER,
    params: [me, nick, server, SERVER_INFO],
  });

  for (const line of extraLines(ctx, to, target)) {
    out.push({
      prefix: server,
      command: Numerics.RPL_WHOISSPECIAL,
      params: [
        me,
        nick,
        clampTrailing(server, Numerics.RPL_WHOISSPECIAL, [me, nick], stripControl(line)),
      ],
    });
  }

  if (target.away !== undefined) out.push(awayReply(ctx, to, target));

  const nowSec = nowSeconds(ctx);
  const idle = Math.max(0, nowSec - (target.lastActivityAt ?? nowSec));
  const signon = target.signonAt ?? nowSec;
  out.push({
    prefix: server,
    command: Numerics.RPL_WHOISIDLE,
    params: [me, nick, String(idle), String(signon), "seconds idle, signon time"],
  });

  out.push({
    prefix: server,
    command: Numerics.RPL_ENDOFWHOIS,
    params: [me, nick, "End of /WHOIS list"],
  });
  return out;
}

/**
 * `WHOIS [<server>] <nick>{,<nick>}`: Req 2.1–2.11, 2.14, 3.2–3.4, 3.7, 4.7.
 * Only the first nick of a comma list is answered.
 */
function handleWhois(ctx: RouterContext, client: Client, msg: IrcMessage): void {
  const raw = msg.params.length >= 2 ? msg.params[1] : msg.params[0];
  const nick = raw?.split(",")[0] ?? "";
  if (nick === "") {
    numeric(ctx, client, Numerics.ERR_NONICKNAMEGIVEN, "No nickname given");
    return;
  }
  const target = ctx.connections.getByNick(nick);
  if (target === undefined || !target.registered) {
    reflectedReply(ctx, client, Numerics.ERR_NOSUCHNICK, [nick], "No such nick/channel");
    reflectedReply(ctx, client, Numerics.RPL_ENDOFWHOIS, [nick], "End of /WHOIS list");
    return;
  }
  for (const reply of buildWhoisReplies(ctx, client, target)) client.send(reply);
}

/** Register WHOIS on the router. */
export function registerWhoisHandler(router: CommandRouter): void {
  router.register("WHOIS", {
    minParams: 0,
    run: (ctx, client, msg) => {
      try {
        handleWhois(ctx, client, msg);
      } catch (error) {
        ctx.logger.error(
          { command: "WHOIS", clientId: client.id, error },
          `WHOIS failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  });
}
