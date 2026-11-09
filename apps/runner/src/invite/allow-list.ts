import { irc_lower } from "@seance/irc-protocol";

/** Who may invite agents. Comparison uses `irc_lower`. */
export interface AllowList {
  allows(inviter: string): boolean;
}

/**
 * public-hardening Requirement 3: with accounts, an inviter must be logged in as the account of
 * its own nick. `accountOf` reads the host now (never cached).
 */
export interface InviterAuth {
  /** True when the ircd has accounts; false keeps the nick-only check (local development). */
  readonly required: boolean;
  /** The account a registered client is logged in as, or undefined. */
  readonly accountOf: (nick: string) => string | undefined;
}

/**
 * Builds an allow-list from the validated `SEANCE_INVITERS` entries
 * (see `loadRunnerConfig`). `undefined` or an empty list permits everyone, or, with
 * `auth.required`, every authenticated account.
 */
export function parseInviters(inviters: readonly string[] | undefined, auth?: InviterAuth): AllowList {
  const authenticated = (nick: string): boolean => {
    if (auth === undefined || !auth.required) return true;
    const account = auth.accountOf(nick);
    return account !== undefined && irc_lower(account) === irc_lower(nick);
  };
  if (inviters === undefined || inviters.length === 0) {
    return { allows: (inviter) => authenticated(inviter) };
  }
  const permitted: ReadonlySet<string> = new Set(inviters.map((nick) => irc_lower(nick)));
  return { allows: (inviter) => permitted.has(irc_lower(inviter)) && authenticated(inviter) };
}
