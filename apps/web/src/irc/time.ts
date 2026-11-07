const MS_PER_MINUTE = 60_000;
const MINUTES_PER_DAY = 1440;

/**
 * Format an epoch timestamp as "HH:MM" (24 hour).
 * `offsetMinutes` is the zone offset east of UTC (local = UTC + offset);
 * pass `-new Date().getTimezoneOffset()` from the UI.
 */
export function formatClock(epochMs: number, offsetMinutes: number): string {
  if (!Number.isFinite(epochMs) || !Number.isFinite(offsetMinutes)) {
    throw new RangeError(`formatClock: non-finite input (${String(epochMs)}, ${String(offsetMinutes)})`);
  }
  const totalMinutes = Math.floor(epochMs / MS_PER_MINUTE) + Math.trunc(offsetMinutes);
  const minuteOfDay = ((totalMinutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hh = String(Math.floor(minuteOfDay / 60)).padStart(2, "0");
  const mm = String(minuteOfDay % 60).padStart(2, "0");
  return `${hh}:${mm}`;
}
