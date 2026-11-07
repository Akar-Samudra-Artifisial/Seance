import { createHash } from "node:crypto";
import { irc_lower } from "@seance/irc-protocol";

const MAX_LENGTH = 64;
const PREFIX_LENGTH = 38;
const HASH_HEX_LENGTH = 24;

const encoder = new TextEncoder();

function isKept(codePoint: number): boolean {
  return (
    (codePoint >= 0x61 && codePoint <= 0x7a) || // a-z
    (codePoint >= 0x30 && codePoint <= 0x39) || // 0-9
    codePoint === 0x2d // -
  );
}

/**
 * Maps a channel name to a directory/branch-safe name (Sanitized_Channel).
 * Total and pure. Output matches `^[a-z0-9_-]{1,64}$` and is never `.` or `..`.
 * Two names give the same value only if their `irc_lower` forms are equal.
 */
export function sanitizeChannel(name: string): string {
  const lowered = irc_lower(name);
  const rest = lowered.startsWith("#") ? lowered.slice(1) : lowered;
  let out = lowered.startsWith("#") ? "" : "_x";

  for (const ch of rest) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && isKept(cp)) {
      out += ch;
      continue;
    }
    for (const byte of encoder.encode(ch)) {
      out += `_${byte.toString(16).padStart(2, "0")}`;
    }
  }

  if (out.length === 0) {
    // Not `_00`: that is the encoding of a NUL byte. `_empty` cannot be produced
    // otherwise (`_` is followed by two hex digits, or by `x` for non-# names).
    return "_empty";
  }
  if (out.length > MAX_LENGTH) {
    const digest = createHash("sha256").update(lowered, "utf8").digest("hex");
    return `${out.slice(0, PREFIX_LENGTH)}__${digest.slice(0, HASH_HEX_LENGTH)}`;
  }
  return out;
}
