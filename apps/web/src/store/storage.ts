import { validateServerUrl } from "../config/connect-src.js";
import { isValidNick } from "../irc/index.js";

export const NICK_KEY = "seance.nick";
export const SERVER_URL_KEY = "seance.serverUrl";

/** The subset of `Storage` the client uses. */
export interface KeyValueBackend {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Validated values; `null` means absent or invalid (the caller falls back to defaults). */
export interface StoredPrefs {
  readonly nick: string | null;
  readonly serverUrl: string | null;
}

/** Only nick and server URL are persisted. There is deliberately no password field. */
export interface ClientStorage {
  read(): StoredPrefs;
  /** Throws when the backend refuses the write (quota, private mode). */
  write(prefs: { readonly nick: string; readonly serverUrl: string }): void;
}

export function createClientStorage(
  backend: KeyValueBackend | null,
  allowedOrigins: readonly string[],
): ClientStorage {
  return {
    read() {
      if (backend === null) return { nick: null, serverUrl: null };
      let rawNick: string | null = null;
      let rawUrl: string | null = null;
      try {
        rawNick = backend.getItem(NICK_KEY);
        rawUrl = backend.getItem(SERVER_URL_KEY);
      } catch {
        // An unreadable backend behaves like an empty one (defaults apply).
        return { nick: null, serverUrl: null };
      }
      const nick = rawNick !== null && isValidNick(rawNick) ? rawNick : null;
      const checked = rawUrl === null ? null : validateServerUrl(rawUrl, allowedOrigins);
      return { nick, serverUrl: checked !== null && checked.ok ? checked.url : null };
    },
    write(prefs) {
      if (backend === null) throw new Error("localStorage is not available");
      backend.setItem(NICK_KEY, prefs.nick);
      // Persist the origin only: a path, query or credentials never reach localStorage.
      const checked = validateServerUrl(prefs.serverUrl, allowedOrigins);
      if (!checked.ok) throw new Error(`refusing to store server URL: ${checked.error}`);
      backend.setItem(SERVER_URL_KEY, checked.origin);
    },
  };
}

/** Browser adapter over `localStorage`; falls back to no backend when access is denied. */
export function createBrowserStorage(allowedOrigins: readonly string[]): ClientStorage {
  let backend: KeyValueBackend | null = null;
  try {
    backend = globalThis.localStorage;
  } catch {
    backend = null;
  }
  return createClientStorage(backend, allowedOrigins);
}
