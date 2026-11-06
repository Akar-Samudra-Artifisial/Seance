import type { IrcMessage } from "@seance/irc-protocol";
import type { Client } from "../client.js";
import type { CommandRouter, RouterContext } from "../command-router.js";

/** `PING <token>` -> `PONG <server> :<token>` (Req 4.1; 461 via minParams, Req 4.2). */
function handlePing(ctx: RouterContext, client: Client, msg: IrcMessage): void {
  const token = msg.params[0];
  if (token === undefined) return; // unreachable: router enforces minParams
  client.send({
    prefix: ctx.serverName,
    command: "PONG",
    params: [ctx.serverName, token],
  });
}

/**
 * `PONG`: nothing to do. The router already reset the idle timer and cancelled
 * the pending ping timeout when the line arrived (Req 4.3, 4.4).
 */
function handlePong(): void {}

/** Register PING and PONG on the router. */
export function registerKeepAliveHandlers(router: CommandRouter): void {
  router
    .register("PING", { minParams: 1, run: handlePing })
    .register("PONG", { minParams: 0, run: handlePong });
}
