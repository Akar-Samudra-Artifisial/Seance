/** Opaque timer handle; callers must not inspect it. */
export type TimerHandle = object;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(h: TimerHandle): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref();
    return t;
  },
  clearTimeout: (h) => {
    clearTimeout(h as NodeJS.Timeout);
  },
};

/** Owns timer handles so shutdown can clear them and prove none is left. */
export class TimerSet {
  readonly #clock: Clock;
  readonly #handles = new Set<TimerHandle>();

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  set(fn: () => void, ms: number): TimerHandle {
    const h: TimerHandle = this.#clock.setTimeout(() => {
      this.#handles.delete(h);
      fn();
    }, ms);
    this.#handles.add(h);
    return h;
  }

  clear(h: TimerHandle): void {
    this.#handles.delete(h);
    this.#clock.clearTimeout(h);
  }

  clearAll(): void {
    for (const h of [...this.#handles]) this.clear(h);
  }

  get size(): number {
    return this.#handles.size;
  }
}
