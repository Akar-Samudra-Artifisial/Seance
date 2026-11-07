/** Default dev-only Ircd WebSocket origin, always allowed in development (R15.9). */
const DEV_IRCD_ORIGIN = "ws://127.0.0.1:6668";

export interface BuildCspOptions {
  /** Fresh per-request nonce (base64-ish, no whitespace, quotes or semicolons). */
  readonly nonce: string;
  /** Origins permitted in `connect-src`, in addition to `'self'`. */
  readonly connectOrigins: readonly string[];
  /** Development mode relaxes script/style/connect directives for Next.js tooling. */
  readonly dev: boolean;
}

const UNSAFE_VALUE = /[\s;,'"]/;

/**
 * Builds the single-line Content-Security-Policy header value.
 * Pure: no I/O, no environment access.
 */
export function buildCsp({ nonce, connectOrigins, dev }: BuildCspOptions): string {
  if (nonce.length === 0 || UNSAFE_VALUE.test(nonce)) {
    throw new Error("buildCsp: nonce must be non-empty and free of whitespace, quotes, ';' and ','");
  }
  for (const origin of connectOrigins) {
    if (origin.length === 0 || UNSAFE_VALUE.test(origin)) {
      throw new Error(`buildCsp: invalid connect origin ${JSON.stringify(origin)}`);
    }
  }

  const scriptSrc = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"];
  const styleSrc = ["'self'", `'nonce-${nonce}'`];
  const connectSrc = ["'self'", ...connectOrigins];

  if (dev) {
    scriptSrc.push("'unsafe-eval'");
    styleSrc.push("'unsafe-inline'");
    if (!connectSrc.includes(DEV_IRCD_ORIGIN)) connectSrc.push(DEV_IRCD_ORIGIN);
  }

  const directives: readonly (readonly [string, readonly string[]])[] = [
    ["default-src", ["'self'"]],
    ["script-src", scriptSrc],
    ["style-src", styleSrc],
    ["connect-src", connectSrc],
    ["img-src", ["'self'", "data:"]],
    ["font-src", ["'self'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
  ];

  return directives.map(([name, values]) => `${name} ${values.join(" ")}`).join("; ");
}
