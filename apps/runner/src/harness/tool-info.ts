/**
 * Tool classification from ACP frames. Everything here is untrusted agent data.
 *
 * Real kiro-cli (3.x) sends `session/request_permission` with only `toolCallId`, `title` and
 * `rawInput`; `kind` and `locations` arrive earlier in `session/update`
 * (`tool_call` / `tool_call_update`) for the same `toolCallId`. The harness caches those per session
 * (see `ToolCache`) and resolves the request from cache first, then from `rawInput`. Nothing
 * matching means kind `other`, which the policy rejects (fail closed).
 */
import type { Json, JsonObject } from "../acp/frames.js";
import type { ToolInfo } from "./harness.js";

/** Metadata seen so far for one toolCallId. */
export interface ToolMeta {
  readonly kind?: string;
  readonly title?: string;
  readonly paths: readonly string[];
  readonly rawInput?: JsonObject;
}

const asObj = (v: Json | undefined): JsonObject | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as JsonObject) : undefined;
const asStr = (v: Json | undefined): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * `rawInput.command` values of the edit tool, compared after `verbKey` (kiro 3.0 sends
 * `str_replace`, kiro 3.1 sends `strReplace`).
 */
const EDIT_VERBS: ReadonlySet<string> = new Set(["create", "strreplace", "insert", "write", "append"]);

/** Lower-cased with `_` and `-` removed, so `str_replace`, `strReplace` and `str-replace` compare equal. */
const verbKey = (verb: string): string => verb.trim().toLowerCase().replace(/[_-]/g, "");
/** `rawInput.command` values of read-only tools; they need a `path` to count as reads. */
const READ_VERBS: ReadonlySet<string> = new Set(["read", "ls", "glob", "grep"]);

/**
 * The paths a tool call acts on: `locations[].path` and `rawInput.path`.
 *
 * `content[]` diff paths are deliberately NOT used. kiro-cli (3.0 and 3.1, spike S11) builds the diff
 * path by resolving the relative `rawInput.path` against the agent's PROCESS cwd (the agents directory),
 * not the session cwd, while the write itself goes to the session cwd. Using the diff path made every
 * relative edit look like a write outside the worktree. `rawInput.path` is the tool's actual input and
 * `locations` repeat it, so both are resolved against the worktree by `canonicalise`. A call with no
 * path left is a write without a path and is rejected (`unresolved-path`), so this fails closed.
 */
export function pathsOf(update: JsonObject): string[] {
  const out: string[] = [];
  const add = (p: string | undefined): void => {
    if (p !== undefined && !out.includes(p)) out.push(p);
  };
  const locations = update["locations"];
  if (Array.isArray(locations)) {
    for (const loc of locations as readonly Json[]) add(asStr(asObj(loc)?.["path"]));
  }
  add(asStr(asObj(update["rawInput"])?.["path"]));
  return out;
}

/** Merges a `tool_call` / `tool_call_update` into what is known about the call. */
export function mergeMeta(previous: ToolMeta | undefined, update: JsonObject): ToolMeta {
  const kind = asStr(update["kind"]) ?? previous?.kind;
  const title = asStr(update["title"]) ?? previous?.title;
  const rawInput = asObj(update["rawInput"]) ?? previous?.rawInput;
  const paths = [...(previous?.paths ?? [])];
  for (const p of pathsOf(update)) if (!paths.includes(p)) paths.push(p);
  return {
    ...(kind !== undefined ? { kind } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(rawInput !== undefined ? { rawInput } : {}),
    paths,
  };
}

/** Kind inferred from `rawInput` alone; undefined when nothing matches. */
export function inferKind(rawInput: JsonObject | undefined): string | undefined {
  const command = asStr(rawInput?.["command"]);
  if (command === undefined || command.trim() === "") return undefined;
  const hasPath = asStr(rawInput?.["path"]) !== undefined;
  // A verb is a single word; anything with whitespace is a shell command line.
  if (/\s/.test(command.trim())) return "execute";
  const verb = verbKey(command);
  if (EDIT_VERBS.has(verb)) return "edit";
  // `ls` with a path is the read tool; a bare `ls` is a shell command and gets the stricter class.
  if (READ_VERBS.has(verb) && hasPath) return "read";
  return "execute";
}

/**
 * Builds the ToolInfo for a permission request or tool-call event.
 * `kind`: explicit frame value, else cached, else inferred, else `other`.
 */
export function resolveTool(frame: JsonObject, cached: ToolMeta | undefined): ToolInfo {
  const merged = mergeMeta(cached, frame);
  const kind = merged.kind ?? inferKind(merged.rawInput) ?? "other";
  const info = { kind, title: merged.title ?? "", paths: merged.paths };
  const command = asStr(merged.rawInput?.["command"]);
  // For edit-style tools `rawInput.command` is a verb ("create"), not a shell command line.
  return kind === "execute" && command !== undefined ? { ...info, command } : info;
}

/** Bounded per-session cache of tool metadata by toolCallId; cleared at turn end. */
export class ToolCache {
  readonly #max: number;
  readonly #entries = new Map<string, ToolMeta>();

  constructor(max = 128) {
    this.#max = max;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(id: string): ToolMeta | undefined {
    return this.#entries.get(id);
  }

  /** Records an update; the oldest entry is dropped beyond the bound. */
  record(id: string, update: JsonObject): ToolMeta {
    const merged = mergeMeta(this.#entries.get(id), update);
    this.#entries.delete(id);
    this.#entries.set(id, merged);
    if (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next();
      if (!oldest.done) this.#entries.delete(oldest.value);
    }
    return merged;
  }

  clear(): void {
    this.#entries.clear();
  }
}
