// public-hardening Requirement 6.1: the values in the Kiro login are secrets the agents must
// never print. Read once at start (podman mode), bounded in depth, size and count.
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_DEPTH = 4;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_SECRETS = 2000;
/** JSON string values at least this long count as secrets. */
const MIN_JSON_VALUE = 16;
/** Token-like runs in text or binary files: long, from a token alphabet, with a digit or mixed case. */
const TOKEN_RUN = /[A-Za-z0-9._~+/=|-]{24,}/g;
/** A whole JSON value made only of token characters (no `:`, spaces or `@`). `|` occurs in refresh tokens. */
const TOKEN_VALUE = /^[A-Za-z0-9._~+/=|-]+$/;

function looksLikeToken(s: string): boolean {
  return /\d/.test(s) || (/[a-z]/.test(s) && /[A-Z]/.test(s));
}

function fromJson(value: unknown, out: Set<string>): void {
  if (out.size >= MAX_SECRETS) return;
  if (typeof value === "string") {
    // Token-shaped values only: URLs, dates and prose would make every 8-character window of
    // "https://..." a redaction trigger in ordinary agent output.
    if (value.length >= MIN_JSON_VALUE && TOKEN_VALUE.test(value) && looksLikeToken(value)) out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) fromJson(v, out);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value)) fromJson(v, out);
  }
}

/** Secret candidates in one file's bytes: JSON string values, otherwise token-like runs. */
export function secretsInFile(bytes: Buffer): readonly string[] {
  const out = new Set<string>();
  const text = bytes.toString("utf8");
  try {
    fromJson(JSON.parse(text), out);
    return [...out];
  } catch {
    // Not JSON (an SQLite file, a plain token file): fall back to printable runs, like `strings`.
  }
  const printable = bytes.toString("latin1");
  for (const m of printable.matchAll(TOKEN_RUN)) {
    if (out.size >= MAX_SECRETS) break;
    if (looksLikeToken(m[0])) out.add(m[0]);
  }
  return [...out];
}

/**
 * Collects secret values from the regular files under `dir` (symlinks are not followed). Never
 * throws for one unreadable file; it is skipped and named through `onSkip`.
 */
export async function readAuthSecrets(dir: string, onSkip?: (path: string, reason: string) => void): Promise<readonly string[]> {
  const out = new Set<string>();
  let total = 0;
  const walk = async (path: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || out.size >= MAX_SECRETS || total >= MAX_TOTAL_BYTES) return;
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (err) {
      onSkip?.(path, (err as NodeJS.ErrnoException).code ?? "unreadable");
      return;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        await walk(child, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const info = await lstat(child);
        if (info.size > MAX_FILE_BYTES || total + info.size > MAX_TOTAL_BYTES) {
          onSkip?.(child, "too large");
          continue;
        }
        total += info.size;
        for (const s of secretsInFile(await readFile(child))) {
          if (out.size >= MAX_SECRETS) break;
          out.add(s);
        }
      } catch (err) {
        onSkip?.(child, (err as NodeJS.ErrnoException).code ?? "unreadable");
      }
    }
  };
  await walk(dir, 0);
  return [...out];
}
