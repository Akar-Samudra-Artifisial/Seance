import type { RouterLogger } from "./command-router.js";

/** Socket error codes caused by an ordinary peer disconnect. */
export const TRANSIENT_SOCKET_CODES: ReadonlySet<string> = new Set(["ECONNRESET", "EPIPE"]);

/** The string `code` of a socket error, or undefined when it has none. */
export function socketErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Log a socket error: transient resets at debug, everything else at error.
 * The caller still destroys the socket.
 */
export function logSocketError(
  logger: RouterLogger,
  label: string,
  clientId: string,
  error: Error,
): void {
  const code = socketErrorCode(error);
  if (code !== undefined && TRANSIENT_SOCKET_CODES.has(code)) {
    logger.debug?.({ clientId, code }, `${label} reset for ${clientId}: ${code}`);
    return;
  }
  logger.error({ clientId, error }, `${label} error for ${clientId}: ${error.message}`);
}
