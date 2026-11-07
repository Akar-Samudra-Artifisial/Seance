export interface CreditsLine {
  readonly channel: string;
  readonly used: number;
  readonly total: number;
}

// `credits: <channel> <used> / total <total>`; plain decimals only (no sign, exponent, NaN or Infinity).
const CREDITS_RE = /^credits: (\S{1,200}) (\d{1,15}(?:\.\d{1,15})?) \/ total (\d{1,15}(?:\.\d{1,15})?)$/;

/** Parse the runner's `320` credits text. Untrusted input: anything else yields undefined. */
export function parseCreditsLine(text: string): CreditsLine | undefined {
  const m = CREDITS_RE.exec(text);
  if (m === null) return undefined;
  const [, channel, usedRaw, totalRaw] = m;
  if (channel === undefined || usedRaw === undefined || totalRaw === undefined) return undefined;
  const used = Number(usedRaw);
  const total = Number(totalRaw);
  if (!Number.isFinite(used) || !Number.isFinite(total) || used < 0 || total < 0) return undefined;
  return { channel, used, total };
}
