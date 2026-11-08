/**
 * IPv4 CIDR helpers for `SEANCE_SANDBOX_BLOCKED_CIDRS` (agent-sandbox review finding 4). Pure.
 */

const CIDR = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

function parse(cidr: string): { readonly base: number; readonly bits: number } | undefined {
  const m = CIDR.exec(cidr);
  if (m === null) return undefined;
  const octets = m.slice(1, 5).map(Number);
  const bits = Number(m[5]);
  if (octets.some((o) => o > 255) || bits > 32) return undefined;
  const ip = octets.reduce((acc, o) => acc * 256 + o, 0);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (ip & mask) >>> 0, bits };
}

/** True for `a.b.c.d/n` with every octet 0..255 and n 0..32. */
export function isCidr(value: string): boolean {
  return parse(value) !== undefined;
}

const dotted = (n: number): string => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");

/**
 * The `ip:443` the Probe tries inside `cidr`: the first address after the network address (the
 * network address itself for a /31 or /32). Host bits in the entry are masked off. The Probe passes
 * when that address is unreachable; it is best effort, since a dropped packet and a silent host
 * look the same, so `docs/SANDBOX.md` tells operators to point a probe at a host they know is live.
 */
export function probeTargetIn(cidr: string): string {
  const p = parse(cidr);
  if (p === undefined) throw new RangeError(`not an IPv4 CIDR: ${JSON.stringify(cidr)}`);
  const first = p.bits >= 31 ? p.base : (p.base + 1) >>> 0;
  return `${dotted(first)}:443`;
}
