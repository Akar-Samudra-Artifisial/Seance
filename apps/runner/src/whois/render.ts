import { irc_lower } from "@seance/irc-protocol";

import type { AgentSnapshot, ChannelSnapshot } from "./snapshot.js";

/** The ircd sends at most this many `320` lines per WHOIS (`WHOIS_EXTRA_MAX`). */
export const WHOIS_MAX_LINES = 10;

/**
 * Per-line cap in UTF-8 bytes. The ircd re-clamps against the real prefix, so this
 * is a conservative budget that keeps `:server 320 nick target :<line>\r\n` under 512 bytes.
 */
export const WHOIS_LINE_MAX_BYTES = 300;

const encoder = new TextEncoder();

/** Removes CR, LF and NUL, then cuts at a code point boundary to at most `maxBytes` UTF-8 bytes. */
function fit(text: string): string {
  const clean = text.replace(/[\r\n\0]/g, " ");
  if (clean.length * 3 <= WHOIS_LINE_MAX_BYTES || encoder.encode(clean).length <= WHOIS_LINE_MAX_BYTES) {
    return clean;
  }
  let out = "";
  let bytes = 0;
  for (const ch of clean) {
    const n = encoder.encode(ch).length;
    if (bytes + n > WHOIS_LINE_MAX_BYTES) break;
    out += ch;
    bytes += n;
  }
  return out;
}

/**
 * `skills: a, b` (agent-skills Req 3.2). Eight 40-character names exceed the line budget, so only
 * whole names are shown and the rest are counted (`+3 more`); a name is never cut in half.
 * Skill names are ASCII (`[a-z0-9-]`), so characters equal bytes.
 */
function skillsLine(skills: readonly string[]): string {
  const full = `skills: ${skills.join(", ")}`;
  if (full.length <= WHOIS_LINE_MAX_BYTES) return full;
  for (let keep = skills.length - 1; keep >= 1; keep -= 1) {
    const line = `skills: ${skills.slice(0, keep).join(", ")}, +${skills.length - keep} more`;
    if (line.length <= WHOIS_LINE_MAX_BYTES) return line;
  }
  return `skills: ${skills.length} skills`;
}

/** The value of the `status:` line of `WHOIS`. */
export type AgentStatus = "idle" | "prompting" | "cooldown" | "away";

function status(entry: AgentSnapshot, open: readonly ChannelSnapshot[]): AgentStatus {
  if (open.some((c) => c.state === "prompting")) return "prompting";
  if (open.some((c) => c.state === "cooldown")) return "cooldown";
  if (entry.away !== undefined) return "away";
  return "idle";
}

/**
 * The `status:` of `renderWhois` for one Agent (runner-services Req 4.2): the NickServ roster and
 * `WHOIS` always agree. An Agent without a snapshot entry (never invited) is `idle`.
 */
export function agentStatus(entry: AgentSnapshot | undefined): AgentStatus {
  if (entry === undefined) return "idle";
  return status(entry, [...entry.channels.values()].filter((c) => c.state !== "closed"));
}

/** Orders by `irc_lower(name)` using code-unit comparison (locale independent). */
function byLoweredName(a: ChannelSnapshot, b: ChannelSnapshot): number {
  const x = irc_lower(a.name);
  const y = irc_lower(b.name);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Pure rendering of one Agent's Whois_Snapshot entry (Requirements 10.4–10.8, 10.19, 10.20).
 * `undefined` gives `[]`; missing `model` or `tools` just drops that line. The result has
 * at most {@link WHOIS_MAX_LINES} lines, each within {@link WHOIS_LINE_MAX_BYTES}.
 * Never throws and never mutates `entry`.
 */
export function renderWhois(entry: AgentSnapshot | undefined): readonly string[] {
  if (entry === undefined) return [];

  const open = [...entry.channels.values()].filter((c) => c.state !== "closed").sort(byLoweredName);
  const lines: string[] = [];
  if (entry.model !== undefined) lines.push(`model: ${entry.model}`);
  if (entry.tools !== undefined) lines.push(`tools: ${entry.tools}`);
  // agent-skills Req 3.1: only when the profile lists skills.
  if (entry.skills !== undefined && entry.skills.length > 0) lines.push(skillsLine(entry.skills));
  lines.push(`status: ${status(entry, open)}`);

  const total = entry.total.toFixed(2);
  for (const c of open) {
    lines.push(`credits: ${c.name} ${c.credits.toFixed(2)} / total ${total}`);
  }
  return lines.slice(0, WHOIS_MAX_LINES).map(fit);
}
