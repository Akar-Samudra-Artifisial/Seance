// public-hardening Requirement 7.1: the real client address behind a reverse proxy (Caddy).
import { isIP } from "node:net";
import { normalizeHost } from "./host.js";

/** Lower-cased, IPv4-mapped prefix removed, so `::ffff:127.0.0.1` and `127.0.0.1` compare equal. */
export function canonicalIp(ip: string): string {
  const t = ip.trim().toLowerCase();
  return t.startsWith("::ffff:") && isIP(t.slice(7)) === 4 ? t.slice(7) : t;
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
