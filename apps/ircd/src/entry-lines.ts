import { serialize } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import { clampBytes, MAX_LINE_BYTES } from "./text-limits.js";

/**
 * Pack space-separated entries into as few lines as possible. `build` wraps a
 * joined entry list into a message; every serialized line is at most 512 UTF-8
 * bytes including CRLF. An entry is never split across lines. No entries gives
 * no lines. An entry that cannot fit alone is cut with `clampBytes` rather than
 * throwing (unreachable with current bounds).
 */
export function packEntries(
  entries: readonly string[],
  build: (joined: string) => IrcMessage,
): readonly IrcMessage[] {
  // Bytes of a line carrying an empty list (includes ":" and CRLF).
  const baseBytes = Buffer.byteLength(serialize(build("")), "utf8");
  const lines: IrcMessage[] = [];
  let current: string[] = [];
  let currentBytes = baseBytes;
  for (const raw of entries) {
    const entry = clampBytes(raw, Math.max(0, MAX_LINE_BYTES - baseBytes));
    const entryBytes = Buffer.byteLength(entry, "utf8");
    const added = entryBytes + (current.length > 0 ? 1 : 0);
    if (current.length > 0 && currentBytes + added > MAX_LINE_BYTES) {
      lines.push(build(current.join(" ")));
      current = [];
      currentBytes = baseBytes;
    }
    currentBytes += entryBytes + (current.length > 0 ? 1 : 0);
    current.push(entry);
  }
  if (current.length > 0) lines.push(build(current.join(" ")));
  return lines;
}
