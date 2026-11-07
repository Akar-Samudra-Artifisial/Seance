import { irc_lower } from "@seance/irc-protocol";

import type { Clock, TimerHandle } from "../clock.js";
import type { RunnerLogger } from "../log.js";
import type { SessionRecord, SessionStore } from "../session/session-store.js";
import type { SessionState } from "../session/machine.js";
import type { WhoisSnapshot } from "../whois/snapshot.js";
import { CreditAccumulator, type MeteringEntry, type MeteringResult } from "./accumulator.js";

/** Coalescing delay for `SessionStore.put`; well under the 1000 ms bound (Req 10.3). */
export const LEDGER_FLUSH_MS = 250;

/** A Session the ledger may cancel when the channel cap is exceeded. */
export interface CancellableSession {
  readonly agent: string;
  readonly state: SessionState;
  cancel(): void;
}

export interface CreditLedgerDeps {
  readonly store: SessionStore;
  readonly snapshot: WhoisSnapshot;
  readonly clock: Clock;
  readonly logger?: RunnerLogger;
  /** `SEANCE_CHANNEL_CREDIT_CAP`; `undefined` means no cap. */
  readonly cap?: number;
  /** All Sessions of a channel (any agent); the ledger cancels those in `prompting`. */
  readonly sessionsOf: (channel: string) => readonly CancellableSession[];
  /** Sends one NOTICE with `text` to each Human_Op of the channel. */
  readonly opNotice: (channel: string, text: string) => void;
  /** ACP session id of an (agent, channel) pair, for the persisted record. */
  readonly acpSessionIdOf?: (agent: string, channel: string) => string | undefined;
}

type Cell = {
  /** Display spelling of the agent nick and channel. */
  readonly agentName: string;
  readonly channelName: string;
  credits: number;
};

const cellKey = (agent: string, channel: string): string => `${agent}\0${channel}`;

/**
 * Credits per (agent, channel). Keyed by `irc_lower` names so it survives
 * Session replacement (kick + invite does not reset the cap). `add` updates
 * the sums and the WhoisSnapshot synchronously; persistence is coalesced.
 */
export class CreditLedger {
  readonly #deps: CreditLedgerDeps;
  readonly #cells = new Map<string, Cell>();
  readonly #channelSum = new Map<string, number>();
  readonly #agentTotal = new Map<string, number>();
  readonly #blocked = new Set<string>();
  readonly #dirty = new Set<string>();
  #timer: TimerHandle | undefined;
  #flushing: Promise<void> = Promise.resolve();

  constructor(deps: CreditLedgerDeps) {
    if (deps.cap !== undefined && !(Number.isFinite(deps.cap) && deps.cap > 0)) {
      throw new RangeError(
        `CreditLedger: cap must be a finite number greater than 0, got ${String(deps.cap)}`,
      );
    }
    this.#deps = deps;
  }

  /** Loads persisted totals after a restart. Call before the first `add`. */
  async restore(): Promise<void> {
    const records = await this.#deps.store.list();
    for (const r of records) {
      if (!Number.isFinite(r.creditsUsed) || r.creditsUsed < 0) {
        this.#deps.logger?.warn("ignoring persisted credits", {
          agent: r.agent,
          channel: r.channel,
          creditsUsed: r.creditsUsed,
        });
        continue;
      }
      this.#set(r.agent, r.channel, r.creditsUsed, false);
    }
  }

  /** Credits of one (agent, channel) pair. */
  amount(agent: string, channel: string): number {
    return this.#cells.get(cellKey(irc_lower(agent), irc_lower(channel)))?.credits ?? 0;
  }

  channelTotal(channel: string): number {
    return this.#channelSum.get(irc_lower(channel)) ?? 0;
  }

  agentTotal(agent: string): number {
    return this.#agentTotal.get(irc_lower(agent)) ?? 0;
  }

  /** Adds `n` (finite, >= 0) credits. Synchronous apart from the scheduled flush. */
  add(agent: string, channel: string, n: number): void {
    if (!Number.isFinite(n) || n < 0) {
      throw new RangeError(`CreditLedger.add: n must be a finite number >= 0, got ${String(n)}`);
    }
    if (n === 0) return;
    const a = irc_lower(agent);
    const c = irc_lower(channel);
    this.#set(a, c, this.amount(a, c) + n, true, agent, channel);
    this.#checkCap(c, channel);
  }

  /**
   * Metadata hook: feeds the Session's accumulator and adds the accepted sum
   * to the ledger, synchronously, so credits are current before the next
   * metadata message is processed (Req 10.1).
   */
  recordMetering(
    acc: CreditAccumulator,
    agent: string,
    channel: string,
    entries: readonly MeteringEntry[],
  ): MeteringResult {
    const result = acc.add(entries);
    if (result.accepted > 0) this.add(agent, channel, result.accepted);
    return result;
  }

  isBlocked(channel: string): boolean {
    return this.#blocked.has(irc_lower(channel));
  }

  /** Clears the credit-blocked mark; returns whether it was set. */
  clearBlocked(channel: string): boolean {
    return this.#blocked.delete(irc_lower(channel));
  }

  /** Lower-cased channels of `agent` that are currently credit-blocked. */
  blockedChannelsOf(agent: string): readonly string[] {
    const a = irc_lower(agent);
    const out: string[] = [];
    for (const [key, cell] of this.#cells) {
      if (!key.startsWith(`${a}\0`)) continue;
      const c = irc_lower(cell.channelName);
      if (this.#blocked.has(c)) out.push(c);
    }
    return out;
  }

  /** Writes pending records now and cancels the timer (shutdown). */
  async flush(): Promise<void> {
    if (this.#timer !== undefined) {
      this.#deps.clock.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    await this.#writeDirty();
  }

  #set(
    a: string,
    c: string,
    credits: number,
    persist: boolean,
    agentName: string = a,
    channelName: string = c,
  ): void {
    const key = cellKey(a, c);
    const prev = this.#cells.get(key);
    const before = prev?.credits ?? 0;
    this.#cells.set(key, {
      agentName: prev?.agentName ?? agentName,
      channelName: prev?.channelName ?? channelName,
      credits,
    });
    this.#channelSum.set(c, (this.#channelSum.get(c) ?? 0) - before + credits);
    this.#agentTotal.set(a, (this.#agentTotal.get(a) ?? 0) - before + credits);
    this.#deps.snapshot.setCredits(prev?.agentName ?? agentName, prev?.channelName ?? channelName, credits);
    if (persist) {
      this.#dirty.add(key);
      this.#schedule();
    }
  }

  #checkCap(c: string, channelName: string): void {
    const cap = this.#deps.cap;
    if (cap === undefined) return;
    const total = this.#channelSum.get(c) ?? 0;
    if (total <= cap || this.#blocked.has(c)) return;
    this.#blocked.add(c);
    for (const s of this.#deps.sessionsOf(channelName)) {
      if (s.state !== "prompting") continue;
      try {
        s.cancel();
      } catch (err) {
        this.#deps.logger?.error("cancel after credit cap failed", {
          channel: c,
          agent: s.agent,
          error: String(err),
        });
      }
    }
    this.#deps.opNotice(
      channelName,
      `credit cap reached for ${channelName}: ${total.toFixed(2)} / ${cap.toFixed(2)}`,
    );
  }

  #schedule(): void {
    if (this.#timer !== undefined) return;
    this.#timer = this.#deps.clock.setTimeout(() => {
      this.#timer = undefined;
      this.#flushing = this.#flushing.then(() => this.#writeDirty());
    }, LEDGER_FLUSH_MS);
  }

  async #writeDirty(): Promise<void> {
    const keys = [...this.#dirty];
    this.#dirty.clear();
    for (const key of keys) {
      const cell = this.#cells.get(key);
      if (cell === undefined) continue;
      const agent = irc_lower(cell.agentName);
      const channel = irc_lower(cell.channelName);
      const record: SessionRecord = {
        agent,
        channel,
        acpSessionId: this.#deps.acpSessionIdOf?.(agent, channel),
        status: this.#deps.snapshot.get(agent)?.channels.get(channel)?.state ?? "closed",
        creditsUsed: cell.credits,
        updatedAt: this.#deps.clock.now(),
      };
      try {
        await this.#deps.store.put(record);
      } catch (err) {
        // Keep it dirty: the next change schedules another attempt.
        this.#dirty.add(key);
        this.#deps.logger?.error("persisting credits failed", {
          agent,
          channel,
          error: String(err),
        });
      }
    }
  }
}
