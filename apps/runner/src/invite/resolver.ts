import type { AgentRegistry } from "../registry/agent-registry.js";
import type { AllowList } from "./allow-list.js";
import type { BanList } from "./ban-list.js";

/** Same shape as the ircd's `InviteResolver`: synchronous, `true` claims the nick. */
export type InviteResolver = (target: string, channel: string, inviter: string) => boolean;

export type InviteResolverDeps = {
  readonly registry: Pick<AgentRegistry, "lookup">;
  readonly bans: Pick<BanList, "has">;
  readonly inviters: AllowList;
};

/**
 * Claims exactly the registered agent nicks that are not banned in the channel
 * and whose inviter is permitted. Reads in-memory state only and changes none.
 */
export function createInviteResolver(deps: InviteResolverDeps): InviteResolver {
  return (target, channel, inviter) =>
    deps.registry.lookup(target) !== undefined &&
    !deps.bans.has(channel, target) &&
    deps.inviters.allows(inviter);
}
