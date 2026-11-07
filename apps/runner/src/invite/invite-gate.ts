/**
 * InviteGate: Invite_Dedup_State plus a per-inviter sliding-window rate limiter.
 *
 * Pure state machine: no timers, no I/O. Time comes only from the event `ts`
 * (milliseconds) passed to `decide`. Every call is synchronous, so two invites
 * handled in the same tick cannot both start (Req 3.10).
 */

export const INVITE_WINDOW_MS = 60_000;

export type GateDecision =
  | { readonly kind: "duplicate" } // Req 3.13: no count, no notice
  | { readonly kind: "rate-limited"; readonly limit: number; readonly retryAfterSec: number } // Req 3.16
  | { readonly kind: "start" };

export class InviteGate {
  readonly #limit: number;
  readonly #keys = new Set<string>();
  readonly #windows = new Map<string, number[]>();

  constructor(limitPerMinute: number) {
    if (!Number.isInteger(limitPerMinute) || limitPerMinute < 1) {
      throw new RangeError(
        `InviteGate limitPerMinute must be a positive integer, got ${String(limitPerMinute)}`,
      );
    }
    this.#limit = limitPerMinute;
  }

  /**
   * Dedup first, then rate. Adds `key` and counts the invitation only on "start".
   * A timestamp counts while it lies in the half-open window (ts - 60000, ts],
   * so `retryAfterSec` is always at least 1.
   */
  decide(key: string, inviterKey: string, ts: number): GateDecision {
    if (this.#keys.has(key)) return { kind: "duplicate" };

    const cutoff = ts - INVITE_WINDOW_MS;
    const live = (this.#windows.get(inviterKey) ?? []).filter((t) => t > cutoff);

    const oldest = live[0];
    if (live.length >= this.#limit && oldest !== undefined) {
      this.#windows.set(inviterKey, live);
      return {
        kind: "rate-limited",
        limit: this.#limit,
        retryAfterSec: Math.ceil((oldest + INVITE_WINDOW_MS - ts) / 1000),
      };
    }

    this.#windows.set(inviterKey, [...live, ts]);
    this.#keys.add(key);
    return { kind: "start" };
  }

  /** Forget a key when its Session closes or creation fails. The rate count is kept. */
  release(key: string): void {
    this.#keys.delete(key);
  }
}
