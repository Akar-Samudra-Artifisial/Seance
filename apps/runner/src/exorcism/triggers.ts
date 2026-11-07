import { irc_lower } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";

import type { RunnerLogger } from "../log.js";
import type { HostVirtualClient, IrcHost, Unsubscribe } from "../ports.js";
import type { SessionManager } from "../session/session-manager.js";
import type { Session } from "../session/session.js";
import type { ExorcismTrigger } from "./exorcism.js";

export type ExorcismTriggersDeps = {
  readonly host: Pick<IrcHost, "subscribe">;
  readonly sessions: Pick<SessionManager, "channelSession" | "sessionsOfAgent">;
  /** `createExorcist(...)`: single-flight per Invite_Key, never rejects. */
  readonly exorcise: (session: Session, trigger: ExorcismTrigger) => Promise<void>;
  readonly logger: RunnerLogger;
};

export interface ExorcismTriggers {
  /**
   * Watches an Agent's own virtual client: its own `PART` exorcises that
   * channel's Session (Req 9.2); an `ERROR` (sent by `close()`) is the QUIT
   * signal and exorcises every Session of the Agent (Req 9.3).
   */
  watchAgent(nick: string, client: HostVirtualClient): Unsubscribe;
  /** Unsubscribes the `irc.kick` listener and every watched client. */
  dispose(): void;
}

/** Nick of a `nick!user@host` prefix; undefined for a server prefix or none. */
function prefixNick(prefix: string | undefined): string | undefined {
  if (prefix === undefined) return undefined;
  const bang = prefix.indexOf("!");
  return bang > 0 ? prefix.slice(0, bang) : undefined;
}

/** Wires the Exorcism triggers: `irc.kick`, own `PART`, and `ERROR` (Req 9.1-9.3). */
export function createExorcismTriggers(deps: ExorcismTriggersDeps): ExorcismTriggers {
  const { host, sessions, exorcise, logger } = deps;
  const watchers = new Set<Unsubscribe>();

  const run = (session: Session, trigger: ExorcismTrigger): void => {
    if (session.state === "closed") return;
    void exorcise(session, trigger).catch((err: unknown) => {
      logger.error("exorcism trigger failed", {
        agent: session.agent,
        channel: session.channel,
        trigger,
        reason: err instanceof Error ? err.message : String(err),
      });
    });
  };

  // Req 9.1: a kick naming an Agent (only nicks with a Session in that channel matter).
  const offKick = host.subscribe("irc.kick", (e) => {
    const session = sessions.channelSession(e.target, e.channel);
    if (session !== undefined) run(session, "kick");
  });

  return {
    watchAgent(nick, client) {
      const own = irc_lower(nick);
      const off = client.onMessage((msg: IrcMessage) => {
        const command = msg.command.toUpperCase();
        if (command === "PART") {
          // Ignore the PART of any other nick.
          const who = prefixNick(msg.prefix);
          const channel = msg.params[0];
          if (who === undefined || irc_lower(who) !== own || channel === undefined) return;
          const session = sessions.channelSession(nick, channel);
          if (session !== undefined) run(session, "part");
        } else if (command === "ERROR") {
          for (const session of sessions.sessionsOfAgent(nick)) run(session, "quit");
        }
      });
      watchers.add(off);
      return () => {
        watchers.delete(off);
        off();
      };
    },
    dispose() {
      offKick();
      for (const off of watchers) off();
      watchers.clear();
    },
  };
}
