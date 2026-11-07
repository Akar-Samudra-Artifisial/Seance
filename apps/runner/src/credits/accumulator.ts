import type { RunnerLogger } from "../log.js";

/** One `_kiro.dev/metadata.meteringUsage[]` element as received (untrusted). */
export type MeteringEntry = unknown;

export type MeteringRejectReason = "unit" | "negative" | "not-finite";

export type MeteringRejection = {
  readonly index: number;
  readonly reason: MeteringRejectReason;
  /** The unit as received, rendered for logging. */
  readonly unit: string;
};

export type MeteringResult = {
  readonly accepted: number;
  readonly rejected: readonly MeteringRejection[];
};

const describeUnit = (unit: unknown): string =>
  typeof unit === "string" ? unit : unit === undefined ? "undefined" : typeof unit;

/**
 * Pure. Accepts an entry only when `unit === "credit"` and `value` is a finite
 * number >= 0. Sums accepted values in array order; every other entry is
 * reported with a reason (`unit`, `not-finite`, `negative`).
 */
export const acceptMetering = (
  entries: readonly MeteringEntry[],
): MeteringResult => {
  let accepted = 0;
  const rejected: MeteringRejection[] = [];
  entries.forEach((entry, index) => {
    const record =
      typeof entry === "object" && entry !== null
        ? (entry as Readonly<Record<string, unknown>>)
        : {};
    const unit = describeUnit(record["unit"]);
    const value = record["value"];
    if (record["unit"] !== "credit") {
      rejected.push({ index, reason: "unit", unit });
    } else if (typeof value !== "number" || !Number.isFinite(value)) {
      rejected.push({ index, reason: "not-finite", unit });
    } else if (value < 0) {
      rejected.push({ index, reason: "negative", unit });
    } else {
      accepted += value;
    }
  });
  return { accepted, rejected };
};

/** Credits of one Session incarnation. The total never decreases. */
export class CreditAccumulator {
  #total = 0;

  constructor(
    private readonly sessionLabel: string,
    private readonly logger?: RunnerLogger,
  ) {}

  /**
   * Adds the accepted entries synchronously and logs one line per rejected
   * entry naming the session, the unit and the reason.
   */
  add(entries: readonly MeteringEntry[]): MeteringResult {
    const result = acceptMetering(entries);
    for (const r of result.rejected) {
      this.logger?.warn("metering entry rejected", {
        session: this.sessionLabel,
        unit: r.unit,
        reason: r.reason,
        index: r.index,
      });
    }
    const next = this.#total + result.accepted;
    if (Number.isFinite(next)) this.#total = next;
    return result;
  }

  get total(): number {
    return this.#total;
  }
}
