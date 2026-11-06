/**
 * Token bucket used for per-connection flood control. Holds up to `capacity`
 * tokens and gains one token every `refillMs` milliseconds. Time comes from an
 * injected clock so tests need no sleeping.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillMs: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(`TokenBucket capacity must be a positive integer, got ${capacity}`);
    }
    if (!Number.isFinite(refillMs) || refillMs <= 0) {
      throw new Error(`TokenBucket refillMs must be positive, got ${refillMs}`);
    }
    this.tokens = capacity;
    this.last = now();
  }

  /** Take one token. Returns false when the bucket is empty. */
  tryTake(): boolean {
    const current = this.now();
    const elapsed = Math.max(0, current - this.last);
    const gained = Math.floor(elapsed / this.refillMs);
    if (gained > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + gained);
      this.last += gained * this.refillMs;
    }
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
