const MAPPED_PREFIX = "::ffff:";
const DOTTED_QUAD = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/**
 * Map a transport peer address to the value stored in `client.host`.
 *
 * - `undefined` and `""` are returned unchanged.
 * - `::ffff:` (any case) plus a dotted-quad becomes the dotted-quad.
 * - `::ffff:` plus anything else, or any address starting with `:`, gets `0`
 *   prepended so the host never starts with `:` in a `nick!user@host` prefix.
 * - Everything else is returned unchanged.
 *
 * Total and idempotent: never throws.
 */
export function normalizeHost(address: string | undefined): string | undefined {
  if (address === undefined || address === "") return address;
  if (address.slice(0, MAPPED_PREFIX.length).toLowerCase() === MAPPED_PREFIX) {
    const rest = address.slice(MAPPED_PREFIX.length);
    if (DOTTED_QUAD.test(rest)) return rest;
  }
  if (address.startsWith(":")) return `0${address}`;
  return address;
}
