import { irc_lower } from "@seance/irc-protocol";

import type { LogLine } from "./builder.js";

export const CHANNEL_LOG_CAPACITY = 50;
export const CHANNEL_LOG_MAX_TEXT_BYTES = 512;

export type ChannelLogEntry = LogLine & { readonly ts: number };

const encoder = new TextEncoder();

/** Truncates to at most `maxBytes` UTF-8 bytes without splitting a code point. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (text.length * 3 <= maxBytes || encoder.encode(text).length <= maxBytes) {
    return text;
  }
  let bytes = 0;
  let end = 0;
  for (const ch of text) {
    const size = encoder.encode(ch).length;
    if (bytes + size > maxBytes) {
      break;
    }
    bytes += size;
    end += ch.length;
  }
  return text.slice(0, end);
}

/** Last 50 messages per `irc_lower(channel)`, text capped at 512 UTF-8 bytes, oldest evicted first. */
export class ChannelLog {
  readonly #byChannel = new Map<string, ChannelLogEntry[]>();

  add(channel: string, entry: { readonly nick: string; readonly text: string; readonly ts: number }): void {
    const key = irc_lower(channel);
    let lines = this.#byChannel.get(key);
    if (lines === undefined) {
      lines = [];
      this.#byChannel.set(key, lines);
    }
    lines.push({
      nick: entry.nick,
      text: truncateUtf8(entry.text, CHANNEL_LOG_MAX_TEXT_BYTES),
      ts: entry.ts,
    });
    if (lines.length > CHANNEL_LOG_CAPACITY) {
      lines.splice(0, lines.length - CHANNEL_LOG_CAPACITY);
    }
  }

  /** Oldest first; returns a copy. */
  lines(channel: string): readonly ChannelLogEntry[] {
    return [...(this.#byChannel.get(irc_lower(channel)) ?? [])];
  }

  clear(channel: string): void {
    this.#byChannel.delete(irc_lower(channel));
  }
}
