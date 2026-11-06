import { Numerics } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import type { Client } from "../client.js";
import type { CommandRouter, RouterContext } from "../command-router.js";
import { deliverMessage } from "./message.js";

/** `PRIVMSG <target> :text`: Req 6.1–6.8, 6.11. */
function handlePrivmsg(ctx: RouterContext, client: Client, msg: IrcMessage): void {
  const nick = client.nick ?? "*";
  const target = msg.params[0];
  if (target === undefined || target === "") {
    client.send({
      prefix: ctx.serverName,
      command: Numerics.ERR_NORECIPIENT,
      params: [nick, "No recipient given (PRIVMSG)"],
    });
    return;
  }
  const text = msg.params[1];
  if (text === undefined || text === "") {
    client.send({
      prefix: ctx.serverName,
      command: Numerics.ERR_NOTEXTTOSEND,
      params: [nick, "No text to send"],
    });
    return;
  }
  deliverMessage(ctx, client, "PRIVMSG", target, text, { reportErrors: true });
}

/** Register PRIVMSG; minParams 0 so this handler emits 411/412 itself. */
export function registerPrivmsgHandler(router: CommandRouter): void {
  router.register("PRIVMSG", { minParams: 0, run: handlePrivmsg });
}
