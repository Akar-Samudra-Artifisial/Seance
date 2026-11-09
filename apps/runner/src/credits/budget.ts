// public-hardening Requirement 5.2: a global credit budget per UTC day, for all agents together.

/** `YYYY-MM-DD` of `ms` in UTC. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export type DailyState = { readonly day: string; readonly credits: number };

/**
 * Credits spent today (UTC). Pure apart from the injected clock: a new day starts at 0. `cap`
 * undefined means no cap (the total is still tracked for WHOIS).
 */
export class DailyBudget {
  #day: string;
  #credits: number;
  #announced: string | undefined;

  constructor(
    private readonly now: () => number,
    readonly cap: number | undefined,
    restored?: DailyState,
  ) {
    if (cap !== undefined && !(Number.isFinite(cap) && cap > 0)) {
      throw new RangeError(`DailyBudget: cap must be a finite number greater than 0, got ${String(cap)}`);
    }
    const today = utcDay(now());
    const valid = restored !== undefined && restored.day === today && Number.isFinite(restored.credits) && restored.credits >= 0;
    this.#day = today;
    this.#credits = valid ? restored.credits : 0;
  }

  #roll(): void {
    const today = utcDay(this.now());
    if (today !== this.#day) {
      this.#day = today;
      this.#credits = 0;
    }
  }

  /** Adds `n` credits. Returns true exactly once per day: on the add that first exceeds the cap. */
  add(n: number): boolean {
    this.#roll();
    if (!Number.isFinite(n) || n <= 0) return false;
    this.#credits += n;
    if (!this.reached() || this.#announced === this.#day) return false;
    this.#announced = this.#day;
    return true;
  }

  /** True while today's total exceeds the cap. */
  reached(): boolean {
    this.#roll();
    return this.cap !== undefined && this.#credits > this.cap;
  }

  today(): number {
    this.#roll();
    return this.#credits;
  }

  state(): DailyState {
    this.#roll();
    return { day: this.#day, credits: this.#credits };
  }

  /** The WHOIS `budget:` line (Requirement 5.4). */
  line(paused: boolean): string {
    const spent = this.today().toFixed(2);
    const base = this.cap === undefined ? `budget: today ${spent} (no daily cap)` : `budget: today ${spent} / ${this.cap.toFixed(2)} (UTC)`;
    const flags = [this.reached() ? "reached" : undefined, paused ? "paused" : undefined].filter((f) => f !== undefined);
    return flags.length === 0 ? base : `${base}, ${flags.join(", ")}`;
  }
}
