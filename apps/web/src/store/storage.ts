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

export const THEME_KEY = "seance.theme";
export const THEMES = ["ghost", "classic"] as const;
export type Theme = (typeof THEMES)[number];

/** True for exactly the two theme names; anything else read from storage is ignored. */
export function isTheme(value: unknown): value is Theme {
  return value === "ghost" || value === "classic";
}

/** Only nick, server URL and the theme name are persisted. There is deliberately no password field. */
export interface ClientStorage {
  read(): StoredPrefs;
  /** The stored theme name, or null when absent, invalid or unreadable. */
  readTheme(): Theme | null;
  /** Throws when the backend refuses the write (quota, private mode). */
  writeTheme(theme: Theme): void;
  /** Throws when the backend refuses the write (quota, private mode). */
  write(prefs: { readonly nick: string; readonly serverUrl: string }): void;
}

/** True when the URL has no path beyond `/`. */
function hasNoPath(url: string): boolean {
  try {
    return new URL(url).pathname === "/";
  } catch {
    return false;
  }
}

/**
 * `defaultServerUrl` migrates older visitors: before the path was persisted, only the origin was
 * stored, so a stored value without a path whose origin equals the default URL's origin is replaced
 * by the default URL (for example `wss://host` becomes `wss://host/ws`).
 */
export function createClientStorage(
  backend: KeyValueBackend | null,
  allowedOrigins: readonly string[],
  defaultServerUrl?: string,
): ClientStorage {
  const defaultChecked = defaultServerUrl === undefined ? null : validateServerUrl(defaultServerUrl, allowedOrigins);
  const migrate = (checked: { readonly url: string; readonly origin: string }): string => {
    if (defaultChecked === null || !defaultChecked.ok) return checked.url;
    if (hasNoPath(checked.url) && checked.origin === defaultChecked.origin) return defaultChecked.url;
    return checked.url;
  };
  return {
    readTheme() {
      if (backend === null) return null;
      try {
        const raw = backend.getItem(THEME_KEY);
        return isTheme(raw) ? raw : null;
      } catch {
        // An unreadable backend behaves like an empty one (the default theme applies).
        return null;
      }
    },
    writeTheme(theme) {
      if (backend === null) throw new Error("localStorage is not available");
      if (!isTheme(theme)) throw new Error(`refusing to store theme "${String(theme)}"`);
      backend.setItem(THEME_KEY, theme);
    },
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
      return { nick, serverUrl: checked !== null && checked.ok ? migrate(checked) : null };
    },
    write(prefs) {
      if (backend === null) throw new Error("localStorage is not available");
      backend.setItem(NICK_KEY, prefs.nick);
      // The validated URL is stored with its path (the server listens on /ws, not on /). Credentials,
      // a query and a fragment are refused by validateServerUrl and never reach localStorage.
      const checked = validateServerUrl(prefs.serverUrl, allowedOrigins);
      if (!checked.ok) throw new Error(`refusing to store server URL: ${checked.error}`);
      backend.setItem(SERVER_URL_KEY, checked.url);
    },
  };
}

/** Browser adapter over `localStorage`; falls back to no backend when access is denied. */
export function createBrowserStorage(allowedOrigins: readonly string[], defaultServerUrl?: string): ClientStorage {
  let backend: KeyValueBackend | null = null;
  try {
    backend = globalThis.localStorage;
  } catch {
    backend = null;
  }
  return createClientStorage(backend, allowedOrigins, defaultServerUrl);
}
