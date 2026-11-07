import { irc_lower } from "@seance/irc-protocol";

export { irc_lower, isValidNick } from "@seance/irc-protocol";

/** Map key for a channel, nick or query name under rfc1459 case-mapping. */
export function keyOf(name: string): string {
  return irc_lower(name);
}

/** Window key of a channel. Namespaced so it can never equal another kind's key. */
export function channelKey(name: string): string {
  return `c:${keyOf(name)}`;
}

/** Window key of a query. A nick such as "Status" cannot reach the status window. */
export function queryKey(name: string): string {
  return `q:${keyOf(name)}`;
}

/** Window key for a PRIVMSG/NOTICE target or echo target. */
export function chatKey(name: string): string {
  return name.startsWith("#") || name.startsWith("&") ? channelKey(name) : queryKey(name);
}
