import { Numerics } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import type { Client } from "../client.js";
import type { CommandRouter, RouterContext } from "../command-router.js";
import { AWAYLEN, clampBytes, stripControl } from "../text-limits.js";

function numeric(ctx: RouterContext, client: Client, code: string, text: string): void {
  client.send({
    prefix: ctx.serverName,
    command: code,
    params: [client.nick ?? "*", text],
  });
}

/**
 * `AWAY [:text]`: Req 1.1, 1.2, 1.8.
 * Non-empty text marks the client away (clamped to AWAYLEN bytes);
 * empty or missing text clears it.
 */
function handleAway(ctx: RouterContext, client: Client, msg: IrcMessage): void {
  const text = msg.params[0] ?? "";
  if (text.length > 0) {
    client.away = clampBytes(stripControl(text), AWAYLEN);
    numeric(ctx, client, Numerics.RPL_NOWAWAY, "You have been marked as being away");
    return;
  }
  delete client.away;
  numeric(ctx, client, Numerics.RPL_UNAWAY, "You are no longer marked as being away");
}

/** Register AWAY on the router. minParams 0: no text means "back". */
export function registerAwayHandler(router: CommandRouter): void {
  router.register("AWAY", { minParams: 0, run: handleAway });
}
