export interface ConnectConfig {
  readonly defaultUrl: string;
  readonly allowedOrigins: readonly string[];
}

export const DEFAULT_IRCD_WS_URL = "ws://127.0.0.1:6668";

export type ServerUrlResult =
  | { readonly ok: true; readonly url: string; readonly origin: string }
  | { readonly ok: false; readonly error: string };

/** Parse a ws:/wss: URL and return its lower-case `scheme://host[:port]` origin. */
function parseWsOrigin(raw: string): { readonly origin: string } | { readonly reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { reason: `"${raw}" is not a valid URL` };
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    return { reason: `"${raw}" must use the ws: or wss: scheme` };
  }
  if (url.hostname === "") {
    return { reason: `"${raw}" has no host` };
  }
  if (url.username !== "" || url.password !== "") {
    return { reason: `"${raw}" must not contain a username or password` };
  }
  if (url.search !== "" || url.hash !== "" || raw.includes("?") || raw.includes("#")) {
    return { reason: `"${raw}" must not contain a query or fragment` };
  }
  return { origin: `${url.protocol}//${url.host}`.toLowerCase() };
}

export function computeConnectConfig(env: {
  readonly NEXT_PUBLIC_IRCD_WS_URL?: string | undefined;
  readonly NODE_ENV?: string | undefined;
}): ConnectConfig {
  const configured = env.NEXT_PUBLIC_IRCD_WS_URL;
  const defaultUrl =
    configured === undefined || configured === "" ? DEFAULT_IRCD_WS_URL : configured;
  const parsed = parseWsOrigin(defaultUrl);
  if ("reason" in parsed) {
    throw new Error(`Invalid NEXT_PUBLIC_IRCD_WS_URL: ${parsed.reason}.`);
  }
  const origins = [parsed.origin];
  if (env.NODE_ENV === "development" && !origins.includes(DEFAULT_IRCD_WS_URL)) {
    origins.push(DEFAULT_IRCD_WS_URL);
  }
  return { defaultUrl, allowedOrigins: origins };
}

export function validateServerUrl(
  raw: string,
  allowedOrigins: readonly string[],
): ServerUrlResult {
  const trimmed = raw.trim();
  const allowed = `Allowed origins: ${allowedOrigins.join(", ")}.`;
  const parsed = parseWsOrigin(trimmed);
  if ("reason" in parsed) {
    return { ok: false, error: `${parsed.reason}. ${allowed}` };
  }
  if (!allowedOrigins.some((o) => o.toLowerCase() === parsed.origin)) {
    return {
      ok: false,
      error: `Server origin ${parsed.origin} is not allowed. ${allowed}`,
    };
  }
  return { ok: true, url: trimmed, origin: parsed.origin };
}
