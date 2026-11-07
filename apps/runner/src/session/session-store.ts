import type { SessionState } from "./machine.js";

/** Persisted state of one (agent, channel) Session. */
export type SessionRecord = {
  readonly agent: string; // irc_lower(nick)
  readonly channel: string; // irc_lower(channel)
  readonly acpSessionId: string | undefined;
  readonly status: SessionState;
  readonly creditsUsed: number; // cumulative for the (agent, channel) pair
  readonly updatedAt: number; // epoch ms from the Clock
};

export interface SessionStore {
  get(agent: string, channel: string): Promise<SessionRecord | undefined>;
  put(record: SessionRecord): Promise<void>;
  list(): Promise<readonly SessionRecord[]>;
}
