import { PASTE_INTERVAL_MS, PASTE_MAX_LINES } from "./types.js";

/** Limits for multi-line pastes (Requirements 7.18, 7.19). */
export const PASTE_LIMITS = {
  maxLines: PASTE_MAX_LINES,
  intervalMs: PASTE_INTERVAL_MS,
} as const;

/** Split text on CRLF, LF and CR and discard empty lines. Line text is unchanged. */
export function splitPaste(text: string): readonly string[] {
  return text.split(/\r\n|\n|\r/).filter((line) => line.length > 0);
}
