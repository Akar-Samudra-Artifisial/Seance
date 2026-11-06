import {
  DEFAULT_IDLE_INTERVAL_MS,
  DEFAULT_PING_TIMEOUT_MS,
} from "./connection-manager.js";
import { DEFAULT_LIMITS, DEFAULT_MAX_CONNECTIONS } from "./limits.js";
import { parseAllowedOrigins } from "./origin.js";
import { DEFAULT_TCP_PORT } from "./tcp-transport.js";
import { DEFAULT_WS_PORT } from "./ws-transport.js";

export type ServerConfig = {
  readonly tcpPort: number;
  readonly wsPort: number;
  readonly host?: string;
  readonly serverName: string;
  readonly serverPassword?: string;
  readonly idleIntervalMs: number;
  readonly pingTimeoutMs: number;
  readonly maxConnections: number;
  readonly floodBurst: number;
  readonly floodRefillMs: number;
  readonly registrationTimeoutMs: number;
  readonly maxWriteBufferBytes: number;
  readonly closeGraceMs: number;
  /** Lower-case origins allowed to open a WebSocket, or `*`. Empty rejects browsers. */
  readonly wsAllowedOrigins: readonly string[];
};

type Env = Readonly<Record<string, string | undefined>>;

function port(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value > 65535) {
    throw new Error(`${name} must be an integer port between 0 and 65535`);
  }
  return value;
}

function positiveMs(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < 1) {
    throw new Error(`${name} must be a positive integer number of milliseconds`);
  }
  return value;
}

function positiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < 1 || !Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

/** Hostname-like server name: no spaces, colons, CR/LF; at most 63 bytes. */
const SERVER_NAME = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,61}[A-Za-z0-9])?$/;

/**
 * Read and validate configuration from environment variables. Throws a
 * descriptive error on invalid values; error messages never include the
 * server password.
 */
export function loadConfig(env: Env): ServerConfig {
  const serverName = env["IRCD_SERVER_NAME"] ?? "seance.local";
  if (!SERVER_NAME.test(serverName)) {
    throw new Error("IRCD_SERVER_NAME must be a hostname-like name (letters, digits, '.', '-')");
  }
  const password = env["IRCD_SERVER_PASSWORD"];
  if (password !== undefined && /[\r\n\0 ]/.test(password)) {
    throw new Error("IRCD_SERVER_PASSWORD must not contain spaces, CR, LF or NUL");
  }
  const host = env["IRCD_HOST"];
  return {
    tcpPort: port(env, "IRCD_TCP_PORT", DEFAULT_TCP_PORT),
    wsPort: port(env, "IRCD_WS_PORT", DEFAULT_WS_PORT),
    ...(host !== undefined && host !== "" ? { host } : {}),
    serverName,
    ...(password !== undefined && password !== "" ? { serverPassword: password } : {}),
    idleIntervalMs: positiveMs(env, "IRCD_IDLE_INTERVAL_MS", DEFAULT_IDLE_INTERVAL_MS),
    pingTimeoutMs: positiveMs(env, "IRCD_PING_TIMEOUT_MS", DEFAULT_PING_TIMEOUT_MS),
    maxConnections: positiveInt(env, "IRCD_MAX_CONNECTIONS", DEFAULT_MAX_CONNECTIONS),
    floodBurst: positiveInt(env, "IRCD_FLOOD_BURST", DEFAULT_LIMITS.floodBurst),
    floodRefillMs: positiveInt(env, "IRCD_FLOOD_REFILL_MS", DEFAULT_LIMITS.floodRefillMs),
    registrationTimeoutMs: positiveInt(
      env,
      "IRCD_REGISTRATION_TIMEOUT_MS",
      DEFAULT_LIMITS.registrationTimeoutMs,
    ),
    maxWriteBufferBytes: positiveInt(
      env,
      "IRCD_MAX_WRITE_BUFFER_BYTES",
      DEFAULT_LIMITS.maxWriteBufferBytes,
    ),
    closeGraceMs: positiveInt(env, "IRCD_CLOSE_GRACE_MS", DEFAULT_LIMITS.closeGraceMs),
    wsAllowedOrigins: parseAllowedOrigins(env["IRCD_WS_ALLOWED_ORIGINS"], "IRCD_WS_ALLOWED_ORIGINS"),
  };
}
