import { irc_lower } from "@seance/irc-protocol";

/** Who may invite agents. Comparison uses `irc_lower`. */
export interface AllowList {
  allows(inviter: string): boolean;
}

/**
 * Builds an allow-list from the validated `SEANCE_INVITERS` entries
 * (see `loadRunnerConfig`). `undefined` or an empty list permits everyone.
 */
export function parseInviters(inviters: readonly string[] | undefined): AllowList {
  if (inviters === undefined || inviters.length === 0) {
    return { allows: () => true };
  }
  const permitted: ReadonlySet<string> = new Set(inviters.map((nick) => irc_lower(nick)));
  return { allows: (inviter) => permitted.has(irc_lower(inviter)) };
}
