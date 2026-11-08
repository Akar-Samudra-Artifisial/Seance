import { isValidChannel } from "@seance/irc-protocol";
import type { IrcMessage, ServiceNick } from "@seance/irc-protocol";
import type { Client } from "./client.js";
import type { RouterContext } from "./command-router.js";
import { clampTrailing } from "./text-limits.js";

/**
 * Service_Notice delivery (runner-services Req 2, design D1/D2). A service is a prefix, not a
 * client: it has no connection, no membership and no WHOIS. Delivery goes straight to the
 * recipients, bypasses channel modes and never publishes `irc.message`.
 */
export interface Services {
  /** True when at least the target existed and the line was handed to its recipients. */
  notice(service: ServiceNick, target: string, text: string): boolean;
}

/** CR, LF and NUL removed (Req 2.3); the rest is the caller's text. */
const clean = (text: string): string => text.replace(/[\r\n\0]/g, "");

export function createServices(ctx: RouterContext): Services {
  const prefixOf = (service: ServiceNick): string => `${service}!${service}@services.${ctx.serverName}`;
  return {
    notice(service, target, text) {
      try {
        const prefix = prefixOf(service);
        const recipients: Client[] = [];
        let wireTarget = target;
        if (isValidChannel(target)) {
          const channel = ctx.channels.get(target);
          if (channel === undefined) return false;
          wireTarget = channel.name;
          for (const id of channel.members.keys()) {
            const member = ctx.connections.get(id);
            if (member !== undefined) recipients.push(member);
          }
        } else {
          const client = ctx.connections.getByNick(target);
          if (client === undefined || !client.registered || client.nick === undefined) return false;
          wireTarget = client.nick;
          recipients.push(client);
        }
        const body = clampTrailing(prefix, "NOTICE", [wireTarget], clean(text));
        const msg: IrcMessage = { prefix, command: "NOTICE", params: [wireTarget, body] };
        for (const r of recipients) {
          try {
            r.send(msg);
          } catch (error) {
            ctx.logger.error({ command: "NOTICE", service, target: wireTarget, clientId: r.id, error }, `service notice from ${service} to ${wireTarget} failed for one recipient: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return true;
      } catch (error) {
        // Req 2.6: logged with service, target and cause; never thrown into the caller.
        ctx.logger.error({ command: "NOTICE", service, target, error }, `service notice from ${service} to ${target} failed: ${error instanceof Error ? error.message : String(error)}`);
        return false;
      }
    },
  };
}
