import type { Line } from "./types.js";
import { BUFFER_CAP } from "./types.js";

/**
 * Append a line and keep only the newest `cap` lines, in order.
 * Never mutates the input array.
 */
export function appendLine(lines: readonly Line[], line: Line, cap: number = BUFFER_CAP): readonly Line[] {
  if (!Number.isInteger(cap) || cap < 1) {
    throw new RangeError(`appendLine: cap must be a positive integer, got ${String(cap)}`);
  }
  const excess = lines.length + 1 - cap;
  if (excess <= 0) return [...lines, line];
  return [...lines.slice(excess), line];
}
