import { irc_lower } from "./casemap.js";

/** The network services (runner-services Requirement 1). They exist only as NOTICE prefixes. */
export const SERVICE_NICKS = ["ChanServ", "NickServ"] as const;

export type ServiceNick = (typeof SERVICE_NICKS)[number];

const SERVICE_KEYS: ReadonlySet<string> = new Set(SERVICE_NICKS.map((n) => irc_lower(n)));

/** True when `nick` equals a service nick under rfc1459 case-mapping (`[]\~` = `{}|^`). Pure. */
export function isServiceNick(nick: string): boolean {
  return SERVICE_KEYS.has(irc_lower(nick));
}
