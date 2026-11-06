import { Numerics, type IrcMessage } from "@seance/irc-protocol";
import type { Client } from "./client.js";
import type { RouterContext } from "./command-router.js";
import { clampTrailing } from "./text-limits.js";

/** Send a numeric reply: `:<server> <code> <nick|*> <rest...>`. */
export function numeric(
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

/** The `nick!user@host` prefix of a client. */
export function prefixOf(ctx: RouterContext, client: Client): string {
  const nick = client.nick ?? "*";
  return `${nick}!${client.user ?? nick}@${client.host ?? ctx.serverName}`;
}

/** Make a value a legal middle parameter: no spaces, no leading ':', not empty. */
function asMiddleParam(value: string): string {
  if (value === "") return "*";
  const noSpaces = value.replace(/ /g, "_");
  return noSpaces.startsWith(":") ? `_${noSpaces.slice(1)}` : noSpaces;
}

/**
 * Send `:<server> <code> <me> <reflected...> :<text>` where each reflected value
 * is untrusted input echoed back. Values are clamped with `clampTrailing` (the
 * other tokens of the line count as leading params, so the budget is the real
 * one) and then made legal middle parameters so `serialize()` cannot throw.
 */
export function reflectedReply(
  ctx: RouterContext,
  client: Client,
  code: string,
  reflected: readonly string[],
  text: string,
): void {
  const me = client.nick ?? "*";
  const done: string[] = [];
  for (let i = 0; i < reflected.length; i++) {
    const value = reflected[i] ?? "";
    const later = reflected.slice(i + 1);
    const clamped = clampTrailing(
      ctx.serverName,
      code,
      [me, ...done, ...later, text],
      value,
    );
    done.push(asMiddleParam(clamped));
  }
  client.send({
    prefix: ctx.serverName,
    command: code,
    params: [me, ...done, text],
  });
}

/** Build `301 RPL_AWAY` for `target`, with the away text clamped to fit. */
export function awayReply(
  ctx: RouterContext,
  to: Client,
  target: Client,
): IrcMessage {
  const me = to.nick ?? "*";
  const nick = target.nick ?? "*";
  const text = clampTrailing(
    ctx.serverName,
    Numerics.RPL_AWAY,
    [me, nick],
    target.away ?? "",
  );
  return {
    prefix: ctx.serverName,
    command: Numerics.RPL_AWAY,
    params: [me, nick, text],
  };
}
