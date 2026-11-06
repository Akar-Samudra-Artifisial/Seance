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

/** Most `320` lines sent per WHOIS. */
export const WHOIS_EXTRA_MAX = 10;

export interface SanitizedWhoisExtra {
  readonly lines: readonly string[];
  /** Human-readable problems; empty when `value` was a clean array of strings. */
  readonly problems: readonly string[];
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Pure: never throws. Keeps string elements in order, then caps at {@link WHOIS_EXTRA_MAX}. */
export function sanitizeWhoisExtra(value: unknown): SanitizedWhoisExtra {
  if (!Array.isArray(value)) {
    return {
      lines: [],
      problems: [`whoisExtra returned ${describeType(value)}, expected an array`],
    };
  }
  const items: readonly unknown[] = value;
  const strings = items.filter((item): item is string => typeof item === "string");
  const skipped = items.length - strings.length;
  return {
    lines: strings.slice(0, WHOIS_EXTRA_MAX),
    problems: skipped > 0 ? [`skipped ${skipped} non-string element(s)`] : [],
  };
}

/** Build the `320` lines from `whoisExtra()`; bad output is logged and sanitized. */
function extraLines(ctx: RouterContext, client: Client, target: Client): readonly string[] {
  if (target.whoisExtra === undefined) return [];
  let value: unknown;
  try {
    value = target.whoisExtra();
  } catch (error) {
    ctx.logger.error(
      { command: "WHOIS", clientId: client.id, targetId: target.id, error },
      `WHOIS extra info failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
  const { lines, problems } = sanitizeWhoisExtra(value);
  if (problems.length > 0) {
    ctx.logger.error(
      { command: "WHOIS", clientId: client.id, targetId: target.id, valueType: describeType(value), problems },
      `WHOIS extra info invalid: ${problems.join("; ")}`,
    );
  }
  return lines;
}

/** Replies for a registered target, in Req 2.1 / 3.2 order. */
function buildWhoisReplies(
  ctx: RouterContext,
  to: Client,
  target: Client,
  out: IrcMessage[],
): void {
  const me = to.nick ?? "*";
  const nick = target.nick ?? "*";
  const user = target.user ?? nick;
  const host = target.host ?? ctx.serverName;
  const server = ctx.serverName;
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
  const replies: IrcMessage[] = [];
  try {
    buildWhoisReplies(ctx, client, target, replies);
  } catch (error) {
    ctx.logger.error(
      { command: "WHOIS", clientId: client.id, targetId: target.id, error },
      `WHOIS reply build failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    // 318 is always last and sent exactly once, whatever happened above.
    replies.push({
      prefix: ctx.serverName,
      command: Numerics.RPL_ENDOFWHOIS,
      params: [client.nick ?? "*", target.nick ?? "*", "End of /WHOIS list"],
    });
  }
  for (const reply of replies) client.send(reply);
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
