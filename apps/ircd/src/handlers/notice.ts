import type { IrcMessage } from "@seance/irc-protocol";
import type { Client } from "../client.js";
import type { CommandRouter, RouterContext } from "../command-router.js";
import { deliverMessage } from "./message.js";

/**
 * `NOTICE <target> :text`: Req 6.9, 6.10.
 * Uses the PRIVMSG delivery path but never replies to the sender: a missing
 * target or text is silently ignored, and delivery failures are suppressed.
 */
function handleNotice(ctx: RouterContext, client: Client, msg: IrcMessage): void {
  const target = msg.params[0];
  if (target === undefined || target === "") return;
  const text = msg.params[1];
  if (text === undefined || text === "") return;
  deliverMessage(ctx, client, "NOTICE", target, text, { reportErrors: false });
}

/** Register NOTICE; minParams 0 so the router never emits 461 for it. */
export function registerNoticeHandler(router: CommandRouter): void {
  router.register("NOTICE", { minParams: 0, run: handleNotice });
}
