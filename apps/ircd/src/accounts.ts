// public-hardening Requirement 2: named accounts for the ircd. One line per account,
// `<nick>:scrypt$<N>$<r>$<p>$<salt b64>$<key b64>`. The file holds hashes only; secrets never.
import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { irc_lower, isValidNick } from "@seance/irc-protocol";

/** Thrown for an unsafe or invalid accounts file. Never contains a hash or a secret. */
export class AccountsFileError extends Error {
  constructor(message: string) {
    super(`IRCD_ACCOUNTS_FILE: ${message}`);
    this.name = "AccountsFileError";
  }
}

export interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

/** Defaults for new hashes: about 50 ms and 16 MiB per verification on a laptop. */
export const DEFAULT_SCRYPT: ScryptParams = { N: 16384, r: 8, p: 1 };
const KEY_BYTES = 32;
const SALT_BYTES = 16;
/** Bounds accepted when reading a file, so a hostile line cannot ask for gigabytes of memory. */
const MAX_N = 1 << 20;
const MAX_R = 32;
const MAX_P = 16;

interface ParsedHash extends ScryptParams {
  readonly salt: Buffer;
  readonly key: Buffer;
}

const HASH = /^scrypt\$(\d{1,8})\$(\d{1,3})\$(\d{1,3})\$([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]+={0,2})$/;

function parseHash(text: string): ParsedHash | undefined {
  const m = HASH.exec(text);
  if (m === null) return undefined;
  const N = Number(m[1]);
  const r = Number(m[2]);
  const p = Number(m[3]);
  // N must be a power of two above 1 (a scrypt requirement).
  if (N < 2 || N > MAX_N || (N & (N - 1)) !== 0 || r < 1 || r > MAX_R || p < 1 || p > MAX_P) return undefined;
  const salt = Buffer.from(m[4] ?? "", "base64");
  const key = Buffer.from(m[5] ?? "", "base64");
  if (salt.length < 8 || key.length < 16) return undefined;
  return { N, r, p, salt, key };
}

function maxmem(p: ScryptParams): number {
  return 128 * p.N * p.r * p.p + 4 * 1024 * 1024;
}

/** `scrypt$N$r$p$salt$key` for `secret` (synchronous; for the tools script and tests). */
export function hashSecret(secret: string, params: ScryptParams = DEFAULT_SCRYPT): string {
  const salt = randomBytes(SALT_BYTES);
  const key = scryptSync(secret, salt, KEY_BYTES, { ...params, maxmem: maxmem(params) });
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

function scryptAsync(secret: string, h: ParsedHash): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, h.salt, h.key.length, { N: h.N, r: h.r, p: h.p, maxmem: maxmem(h) }, (err, key) => {
      if (err !== null) reject(err);
      else resolve(key);
    });
  });
}

export interface Accounts {
  /** Number of accounts. */
  readonly size: number;
  /** True for an account nick under rfc1459 case-mapping. */
  has(nick: string): boolean;
  /** The display spelling of an account nick, or undefined. */
  nameOf(nick: string): string | undefined;
  /**
   * True when `secret` matches the account `nick`. Asynchronous (never blocks the event loop), and
   * an unknown nick still costs one scrypt run, so timing does not reveal which nicks exist.
   */
  verify(nick: string, secret: string): Promise<boolean>;
}

/** Fixed hash used for unknown nicks, so their verification takes as long as a real one. */
let decoy: ParsedHash | undefined;
function decoyHash(): ParsedHash {
  decoy ??= parseHash(hashSecret(randomBytes(16).toString("hex"))) as ParsedHash;
  return decoy;
}

/** Accounts from parsed lines; exported for tests. */
export function accountsFrom(lines: ReadonlyMap<string, { readonly name: string; readonly hash: string }>): Accounts {
  const byKey = new Map<string, { readonly name: string; readonly hash: ParsedHash }>();
  for (const [key, entry] of lines) {
    const hash = parseHash(entry.hash);
    if (hash === undefined) throw new AccountsFileError(`invalid hash for account ${entry.name}`);
    byKey.set(key, { name: entry.name, hash });
  }
  return {
    size: byKey.size,
    has: (nick) => byKey.has(irc_lower(nick)),
    nameOf: (nick) => byKey.get(irc_lower(nick))?.name,
    async verify(nick, secret) {
      const entry = byKey.get(irc_lower(nick));
      const hash = entry?.hash ?? decoyHash();
      try {
        const got = await scryptAsync(secret, hash);
        return entry !== undefined && got.length === hash.key.length && timingSafeEqual(got, hash.key);
      } catch {
        return false;
      }
    },
  };
}

/**
 * Parses the text of an accounts file. Blank lines and `#` comments are allowed. Errors name the
 * line number, never its content.
 */
export function parseAccounts(text: string): Accounts {
  const lines = new Map<string, { readonly name: string; readonly hash: string }>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const colon = line.indexOf(":");
    const name = colon < 0 ? "" : line.slice(0, colon);
    const hash = colon < 0 ? "" : line.slice(colon + 1);
    if (!isValidNick(name)) throw new AccountsFileError(`line ${i + 1}: the account nick is not a valid IRC nick`);
    if (parseHash(hash) === undefined) {
      throw new AccountsFileError(`line ${i + 1}: expected <nick>:scrypt$<N>$<r>$<p>$<salt>$<key> (create it with tools/seance-account.mjs)`);
    }
    const key = irc_lower(name);
    if (lines.has(key)) throw new AccountsFileError(`line ${i + 1}: account ${name} is listed twice`);
    lines.set(key, { name, hash });
  });
  return accountsFrom(lines);
}

/**
 * Reads `path`: a regular file that only its owner may read or write (mode 0600 or 0400).
 * Throws `AccountsFileError` otherwise.
 */
export function loadAccounts(path: string): Accounts {
  let info;
  try {
    info = statSync(path);
  } catch (err) {
    throw new AccountsFileError(`cannot read ${path} (${(err as NodeJS.ErrnoException).code ?? "error"})`);
  }
  if (!info.isFile()) throw new AccountsFileError(`${path} is not a regular file`);
  if ((info.mode & 0o077) !== 0) {
    throw new AccountsFileError(
      `${path} is readable or writable by group or others (mode ${(info.mode & 0o777).toString(8)}); run chmod 600`,
    );
  }
  return parseAccounts(readFileSync(path, "utf8"));
}
