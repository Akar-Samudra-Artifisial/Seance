import type { Clock, TimerHandle } from "../../src/clock.js";

interface Pending {
  readonly id: number;
  readonly at: number;
  readonly fn: () => void;
}

/** Deterministic Clock for tests: time only moves when `advance` is called. */
export class ManualClock implements Clock {
  #now: number;
  #seq = 0;
  readonly #pending = new Map<TimerHandle, Pending>();

  constructor(start = 0) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const handle: TimerHandle = {};
    this.#pending.set(handle, { id: this.#seq++, at: this.#now + Math.max(0, ms), fn });
    return handle;
  }

  clearTimeout(h: TimerHandle): void {
    this.#pending.delete(h);
  }

  /** Number of timers that have not fired and were not cleared. */
  get pending(): number {
    return this.#pending.size;
  }

  /**
   * Move time forward by `ms`, firing due timers in (time, creation) order.
   * Timers scheduled by a callback that fall inside the window also fire.
   */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`ManualClock.advance needs a finite ms >= 0, got ${String(ms)}`);
    }
    const target = this.#now + ms;
    for (;;) {
      let next: [TimerHandle, Pending] | undefined;
      for (const entry of this.#pending) {
        const [, p] = entry;
        if (p.at > target) continue;
        if (next === undefined || p.at < next[1].at || (p.at === next[1].at && p.id < next[1].id)) {
          next = entry;
        }
      }
      if (next === undefined) break;
      this.#pending.delete(next[0]);
      this.#now = Math.max(this.#now, next[1].at);
      next[1].fn();
    }
    this.#now = target;
  }
}
