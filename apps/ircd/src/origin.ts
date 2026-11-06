/** A browser origin: `scheme://host[:port]`, no path, query or fragment. */
const ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/[^\s/?#@]+$/i;

/**
 * Parse a comma-separated allow-list. Entries are trimmed and lower-cased;
 * `*` allows every origin. Throws on an entry that is not a plain origin.
 */
export function parseAllowedOrigins(raw: string | undefined, name: string): readonly string[] {
  if (raw === undefined || raw.trim() === "") return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const entry = part.trim().toLowerCase();
    if (entry === "") continue;
    if (entry !== "*" && !ORIGIN.test(entry)) {
      throw new Error(`${name} entry "${part.trim()}" must be "*" or an origin like https://host[:port]`);
    }
    out.push(entry);
  }
  return out;
}

/**
 * Decide whether a WebSocket upgrade may proceed. A missing `Origin` means a
 * non-browser client and is accepted; a present one must be on the list.
 */
export function isOriginAllowed(
  origin: string | undefined,
  allowed: readonly string[],
): boolean {
  if (origin === undefined || origin === "") return true;
  if (allowed.includes("*")) return true;
  return allowed.includes(origin.toLowerCase());
}
