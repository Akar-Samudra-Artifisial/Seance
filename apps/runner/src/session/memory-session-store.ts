import type { SessionRecord, SessionStore } from "./session-store.js";

const keyOf = (agent: string, channel: string): string => `${agent}\0${channel}`;

/** In-memory SessionStore (tests and embedders); the runner's default is the credits file (`CreditsFile`). */
export class MemorySessionStore implements SessionStore {
  private readonly records = new Map<string, SessionRecord>();

  get(agent: string, channel: string): Promise<SessionRecord | undefined> {
    return Promise.resolve(this.records.get(keyOf(agent, channel)));
  }

  put(record: SessionRecord): Promise<void> {
    this.records.set(keyOf(record.agent, record.channel), { ...record });
    return Promise.resolve();
  }

  list(): Promise<readonly SessionRecord[]> {
    return Promise.resolve([...this.records.values()]);
  }
}
