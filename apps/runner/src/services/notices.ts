// Service_Notice texts (runner-services Req 4 to 7, design D4 to D11). Pure: no I/O, no clock.
// Every number comes from the caller, who just observed it (Req 7.1).
import { basename } from "node:path";
import { sanitizeChannel } from "../worktree/sanitize.js";
import type { AgentStatus } from "../whois/render.js";

/** D4 / Open Point 1: a kick does not release credits, so the line says what WHOIS says. */
export const CREDITS_WORD = "used";

/**
 * A notice body fits one IRC line next to the longest prefix and channel: 512 - CRLF -
 * `:NickServ!NickServ@services.<63-byte host>` (91) - ` NOTICE ` - `#` + 49 characters of up to two
 * bytes (99) - ` :` leaves 310 bytes, so 300 (the WHOIS line budget) is safe (Property 1).
 */
export const NOTICE_MAX_BYTES = 300;

const encoder = new TextEncoder();

/** C0 and C1 controls and DEL are removed; then cut at a code point boundary (Property 1). */
function fit(text: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
  if (encoder.encode(clean).length <= NOTICE_MAX_BYTES) return clean;
  let out = "";
  let bytes = 0;
  for (const ch of clean) {
    const n = encoder.encode(ch).length;
    if (bytes + n > NOTICE_MAX_BYTES) break;
    out += ch;
    bytes += n;
  }
  return out;
}

/** `<basename of SEANCE_WORKSPACES>/<sanitized channel>`: two segments, never absolute (D5). */
export function worktreeNoticeDir(workspaces: string, channel: string): string {
  const root = basename(workspaces.replace(/[/\\]+$/, "")) || "workspaces";
  return `${root}/${sanitizeChannel(channel)}`;
}

/** Req 5.1: `worktree ready: <dir> @ <sha>`. */
export function worktreeReady(dir: string, sha: string): string {
  return fit(`worktree ready: ${dir} @ ${sha}`);
}

/** Req 6.1: `session cancelled, worktree reset to <sha>` or `session closed, worktree reset to <sha>`. */
export function sessionEnded(o: { readonly cancelled: boolean; readonly sha: string }): string {
  return fit(`session ${o.cancelled ? "cancelled" : "closed"}, worktree reset to ${o.sha}`);
}

/**
 * Req 6.3: `<N> file(s) reverted · <X.XX> credits used`, or undefined when there is nothing to say
 * (no reverted file and no credits). `X.XX` uses `toFixed(2)`, like `WHOIS 320`.
 */
export function filesReverted(o: { readonly files: number; readonly credits: number }): string | undefined {
  const files = Number.isFinite(o.files) && o.files > 0 ? Math.floor(o.files) : 0;
  const credits = Number.isFinite(o.credits) && o.credits > 0 ? o.credits : 0;
  if (files === 0 && credits.toFixed(2) === "0.00") return undefined;
  const noun = files === 1 ? "file" : "files";
  return fit(`${String(files)} ${noun} reverted · ${credits.toFixed(2)} credits ${CREDITS_WORD}`);
}

/**
 * Req 4.2: `agents online: <groups>`. Every agent once, in the given (Registry) order, grouped by
 * status in order of first appearance: `a, b (idle); c (prompting)`.
 */
export function agentsOnline(agents: readonly { readonly nick: string; readonly status: AgentStatus }[]): string {
  const groups = new Map<AgentStatus, string[]>();
  for (const a of agents) {
    const list = groups.get(a.status);
    if (list === undefined) groups.set(a.status, [a.nick]);
    else list.push(a.nick);
  }
  const text = [...groups.entries()].map(([status, nicks]) => `${nicks.join(", ")} (${status})`).join("; ");
  return fit(`agents online: ${text === "" ? "none" : text}`);
}
