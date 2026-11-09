// public-hardening Requirement 7.1: the real client address behind a reverse proxy (Caddy).
import { BlockList, isIP } from "node:net";
import { normalizeHost } from "./host.js";

/**
 * One spelling per address, so sets and comparisons agree: IPv4 stays dotted; IPv6 is lower-case
 * and compressed (`0:0:0:0:0:0:0:1` -> `::1`); an IPv4-mapped IPv6 address in either form
 * (`::ffff:127.0.0.1`, `::ffff:7f00:1`) becomes its IPv4 address. Anything that is not an IP
 * literal is returned trimmed and lower-cased.
 */
export function canonicalIp(ip: string): string {
  const t = ip.trim().toLowerCase();
  if (isIP(t) !== 6) return t;
  if (t.startsWith("::ffff:") && isIP(t.slice(7)) === 4) return t.slice(7);
  let compressed: string;
  try {
    // WHATWG URL serialises IPv6 hosts in the RFC 5952 compressed form.
    compressed = new URL(`http://[${t}]/`).hostname.slice(1, -1);
  } catch {
    return t; // e.g. a zone index (`fe80::1%en0`)
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(compressed);
  if (mapped?.[1] !== undefined && mapped[2] !== undefined) {
    const hi = parseInt(mapped[1], 16);
    const lo = parseInt(mapped[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return compressed;
}

/** Loopback ranges: 127.0.0.0/8 and ::1. Checked on the canonical form. */
const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");
LOOPBACK.addSubnet("::ffff:7f00:0", 104, "ipv6"); // in case a mapped form is not canonicalised

/** True for a loopback IP literal in any spelling (`127.0.0.2`, `::1`, `0:0:0:0:0:0:0:1`, `::ffff:127.0.0.1`). */
export function isLoopbackIp(ip: string): boolean {
  const c = canonicalIp(ip);
  const family = isIP(c);
  if (family === 0) return false;
  return LOOPBACK.check(c, family === 4 ? "ipv4" : "ipv6");
}

/** Parses `IRCD_TRUSTED_PROXIES` entries; throws naming the variable on a non-IP entry. */
export function parseTrustedProxies(raw: string | undefined, variable = "IRCD_TRUSTED_PROXIES"): ReadonlySet<string> {
  if (raw === undefined || raw.trim() === "") return new Set();
  const out = new Set<string>();
  for (const entry of raw.split(",")) {
    const ip = entry.trim();
    if (isIP(ip) === 0) throw new Error(`${variable} must list IP addresses, got ${JSON.stringify(ip)}`);
    out.add(canonicalIp(ip));
  }
  return out;
}

/**
 * The client address: the socket peer, unless the peer is a trusted proxy. Then the right-most
 * `X-Forwarded-For` entry that is not itself trusted is used (proxies append, so the left entries
 * are client-controlled). A missing, empty or invalid entry falls back to the peer. Pure.
 */
export function clientIp(
  peer: string | undefined,
  forwardedFor: string | undefined,
  trusted: ReadonlySet<string>,
): string | undefined {
  if (peer === undefined) return undefined;
  const peerIp = canonicalIp(peer);
  if (!trusted.has(peerIp) || forwardedFor === undefined) return peerIp;
  const entries = forwardedFor.split(",").map((e) => e.trim());
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] ?? "";
    if (isIP(entry) === 0) return peerIp;
    const ip = canonicalIp(entry);
    if (!trusted.has(ip)) return ip;
  }
  return peerIp;
}

/** The host shown in prefixes for a client address (the same normalisation as before). */
export function hostForIp(ip: string | undefined): string | undefined {
  return normalizeHost(ip);
}
