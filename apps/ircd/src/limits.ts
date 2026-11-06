import type { TimerApi } from "./connection-manager.js";

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
  registrationTimeoutMs: 60_000,
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
