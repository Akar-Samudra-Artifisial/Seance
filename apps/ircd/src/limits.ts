import { canonicalIp } from "./client-ip.js";
import type { TimerApi } from "./connection-manager.js";
import { normalizeHost } from "./host.js";

/** Per-connection limits applied by `ConnectionSession` and `NetworkClient`. */
export interface SessionLimits {
  /** Token bucket capacity: lines allowed in a burst. */
  readonly floodBurst: number;
  /** Milliseconds per refilled token. */
  readonly floodRefillMs: number;
  /** Time a client has to finish registration. */
  readonly registrationTimeoutMs: number;
  /** Bytes allowed to sit in the write buffer before the client is dropped. */
  readonly maxWriteBufferBytes: number;
  /** Delay between a polite close and destroying the socket. */
  readonly closeGraceMs: number;
  /** Injectable timers and clock for tests. */
  readonly timers?: TimerApi;
  readonly now?: () => number;
}

export const DEFAULT_LIMITS: SessionLimits = {
  floodBurst: 10,
  floodRefillMs: 1000,
  // public-hardening Requirement 1.3: was 60 s; an unauthenticated slot is held for at most 15 s.
  registrationTimeoutMs: 15_000,
  maxWriteBufferBytes: 256 * 1024,
  closeGraceMs: 2000,
};

export const DEFAULT_MAX_CONNECTIONS = 1000;

/**
 * Counts live network connections across all transports and refuses new ones
 * past `max`. Share one gate between TCP and WebSocket.
 */
export class ConnectionGate {
  private active = 0;

  constructor(private readonly max: number = DEFAULT_MAX_CONNECTIONS) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(`maxConnections must be a positive integer, got ${max}`);
    }
  }

  /** Reserve a slot. Returns false when the server is full. */
  tryAcquire(): boolean {
    if (this.active >= this.max) return false;
    this.active += 1;
    return true;
  }

  /** Give a slot back. Never goes below zero. */
  release(): void {
    if (this.active > 0) this.active -= 1;
  }

  get count(): number {
    return this.active;
  }
}

export const DEFAULT_MAX_CONNECTIONS_PER_IP = 5;
export const DEFAULT_MAX_PASS_FAILURES_PER_IP = 10;
/** Window of the per-address `PASS` failure count (public-hardening Requirement 7.3). */
export const PASS_FAILURE_WINDOW_MS = 10 * 60_000;
/** At most this many addresses are tracked; the oldest entries go first (memory bound). */
const MAX_TRACKED_ADDRESSES = 10_000;

/**
 * Live connections per client address, shared by both transports (public-hardening Requirement
 * 7.2). An unknown address (`undefined`) shares one bucket, so it cannot bypass the cap.
 */
export class PerIpGate {
  private readonly counts = new Map<string, number>();

  constructor(private readonly max: number = DEFAULT_MAX_CONNECTIONS_PER_IP) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(`maxConnectionsPerIp must be a positive integer, got ${max}`);
    }
  }

  tryAcquire(ip: string | undefined): boolean {
    const key = ip ?? "?";
    const n = this.counts.get(key) ?? 0;
    if (n >= this.max) return false;
    this.counts.set(key, n + 1);
    return true;
  }

  release(ip: string | undefined): void {
    const key = ip ?? "?";
    const n = this.counts.get(key) ?? 0;
    if (n <= 1) this.counts.delete(key);
    else this.counts.set(key, n - 1);
  }

  countOf(ip: string | undefined): number {
    return this.counts.get(ip ?? "?") ?? 0;
  }
}

/**
 * One key per address whether it comes from the socket (`::1`, `::ffff:1.2.3.4`) or from
 * `client.host` (`0::1`, `1.2.3.4`), so a failure recorded on the client blocks its next socket.
 */
function addressKey(ip: string | undefined): string {
  if (ip === undefined || ip === "") return "?";
  return normalizeHost(canonicalIp(ip)) ?? "?";
}

/**
 * Wrong `PASS` values per client address in a sliding window (public-hardening Requirement 7.3).
 * At `max` failures the address is refused new connections until the oldest failure leaves the
 * window. Time comes from `now`, so tests need no real clock.
 */
export class PassFailures {
  private readonly byIp = new Map<string, number[]>();

  constructor(
    private readonly max: number = DEFAULT_MAX_PASS_FAILURES_PER_IP,
    private readonly now: () => number = Date.now,
    private readonly windowMs: number = PASS_FAILURE_WINDOW_MS,
  ) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(`maxPassFailuresPerIp must be a positive integer, got ${max}`);
    }
  }

  private live(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const kept = (this.byIp.get(key) ?? []).filter((t) => t > cutoff);
    if (kept.length === 0) this.byIp.delete(key);
    else this.byIp.set(key, kept);
    return kept;
  }

  record(ip: string | undefined): void {
    const key = addressKey(ip);
    const list = this.live(key);
    this.byIp.delete(key);
    this.byIp.set(key, [...list, this.now()]);
    if (this.byIp.size > MAX_TRACKED_ADDRESSES) {
      const oldest = this.byIp.keys().next().value;
      if (oldest !== undefined) this.byIp.delete(oldest);
    }
  }

  blocked(ip: string | undefined): boolean {
    return this.live(addressKey(ip)).length >= this.max;
  }
}
