/**
 * Pure deny list for shell tool calls (Requirement 8.7, 8.15).
 *
 * The list is a textual floor, not a sandbox. It never performs I/O and depends only on its
 * arguments. Anything it cannot parse in a way it understands is handled conservatively where
 * that is cheap (glob segments, quote and backslash tricks); constructed names such as
 * `$(printf '.ki%s' ro)` are not recognised and rely on the other layers (sparse-checkout,
 * pre-prompt scan, container).
 */
import { posix } from "node:path";

export type DenyReason = "protected-path" | "deny-list";
export type DenyMatch = { readonly reason: DenyReason };

const PROTECTED_NAMES: readonly string[] = ["agents.md", ".kiro"];

/** Separators for the protected-path reference check (spec list plus braces, commas, `$`, `:`). */
const REFERENCE_SPLIT = /[\s;&|<>'"()`={}$,:]+/;
const PATH_SPLIT = /[/\\]+/;
const GLOB_CHARS = /[*?[]/;

/** Matches one glob segment against a name, case-insensitively. Unparseable globs match (fail closed). */
function globMatches(segment: string, name: string): boolean {
  // POSIX classes and collating elements are too intricate to translate: assume they can match.
  if (/\[[:.=]/.test(segment)) return true;
  let source = "";
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment.charAt(i);
    if (ch === "*") {
      source += ".*";
    } else if (ch === "?") {
      source += ".";
    } else if (ch === "[") {
      let j = i + 1;
      let negate = false;
      const first = segment.charAt(j);
      if (first === "!" || first === "^") {
        negate = true;
        j += 1;
      }
      const bodyStart = j;
      if (segment.charAt(j) === "]") j += 1; // a leading `]` is literal
      while (j < segment.length && segment.charAt(j) !== "]") j += 1;
      if (j >= segment.length) {
        source += "\\[";
      } else {
        const body = segment.slice(bodyStart, j).replace(/[\\^[\]]/g, (c) => `\\${c}`);
        source += `[${negate ? "^" : ""}${body}]`;
        i = j;
      }
    } else {
      source += ch.replace(/[.+^${}()|\\\]]/g, (c) => `\\${c}`);
    }
  }
  try {
    return new RegExp(`^${source}$`, "i").test(name);
  } catch {
    return true;
  }
}

function segmentIsProtected(segment: string): boolean {
  const lower = segment.toLowerCase();
  if (lower.length === 0) return false;
  if (PROTECTED_NAMES.includes(lower)) return true;
  if (GLOB_CHARS.test(segment)) return PROTECTED_NAMES.some((name) => globMatches(segment, name));
  return false;
}

function hasProtectedReference(text: string): boolean {
  for (const token of text.split(REFERENCE_SPLIT)) {
    if (token.length === 0) continue;
    for (const segment of token.split(PATH_SPLIT)) {
      if (segmentIsProtected(segment)) return true;
    }
  }
  return false;
}

/**
 * True when the command mentions `AGENTS.md` or `.kiro` (any letter case) as a token or path
 * segment, or a glob segment that can match either name.
 */
export function referencesProtectedPath(command: string): boolean {
  // Second view with quotes and backslashes removed catches `.k""iro` and `.k\iro`.
  return hasProtectedReference(command) || hasProtectedReference(command.replace(/['"\\]/g, ""));
}

/** Simple commands of a pipeline as word lists (quotes and backslashes removed). */
function simpleCommands(command: string): readonly (readonly string[])[] {
  return command
    .split(/[;&|<>()`{}\n]+/)
    .map((part) =>
      part
        .replace(/['"\\]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 0),
    )
    .filter((words) => words.length > 0);
}

function baseName(word: string): string {
  const parts = word.split("/");
  return (parts[parts.length - 1] ?? "").toLowerCase();
}

function escapesWorktree(operand: string, worktree: string): boolean {
  if (operand.startsWith("/") || operand.startsWith("~") || operand.startsWith("$")) return true;
  if (!posix.isAbsolute(worktree)) return true;
  // A glob segment such as `.*` can match `..`.
  for (const segment of operand.split(PATH_SPLIT)) {
    if (GLOB_CHARS.test(segment) && globMatches(segment, "..")) return true;
  }
  const rel = posix.relative(worktree, posix.join(worktree, operand));
  return rel === ".." || rel.startsWith("../") || posix.isAbsolute(rel);
}

function isDangerousRm(args: readonly string[], worktree: string): boolean {
  let recursive = false;
  let force = false;
  const operands: string[] = [];
  let optionsEnded = false;
  for (const arg of args) {
    if (!optionsEnded && arg === "--") {
      optionsEnded = true;
    } else if (!optionsEnded && arg.startsWith("--")) {
      if (arg === "--recursive") recursive = true;
      if (arg === "--force") force = true;
    } else if (!optionsEnded && arg.startsWith("-") && arg.length > 1) {
      if (/[rR]/.test(arg)) recursive = true;
      if (arg.includes("f")) force = true;
    } else {
      operands.push(arg);
    }
  }
  return recursive && force && operands.some((operand) => escapesWorktree(operand, worktree));
}

function isForcePush(args: readonly string[]): boolean {
  return args.some(
    (arg) =>
      arg.startsWith("--force") ||
      (/^-[A-Za-z]+$/.test(arg) && arg.includes("f")) ||
      arg.startsWith("+"),
  );
}

const INSTALL_TOOLS: ReadonlySet<string> = new Set(["npm", "pnpm", "yarn", "bun", "pip", "pip3", "cargo", "go"]);
const INSTALL_SUBCOMMANDS: ReadonlySet<string> = new Set(["install", "add", "i", "get"]);
const DOWNLOADERS: ReadonlySet<string> = new Set(["curl", "wget"]);
const SHELLS: ReadonlySet<string> = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "fish", "ash", "csh", "tcsh", "eval", "source",
]);

/**
 * Returns the reason the command is denied, or `undefined` when it passes the list.
 * The protected-path reference check runs first.
 */
export function matchDenyList(command: string, worktree: string): DenyMatch | undefined {
  if (referencesProtectedPath(command)) return { reason: "protected-path" };

  const commands = simpleCommands(command);
  let sawDownloader = false;
  let sawShell = false;
  for (const words of commands) {
    const names = words.map(baseName);
    for (const name of names) {
      if (DOWNLOADERS.has(name)) sawDownloader = true;
      if (SHELLS.has(name)) sawShell = true;
    }

    const rm = names.indexOf("rm");
    if (rm >= 0 && isDangerousRm(words.slice(rm + 1), worktree)) return { reason: "deny-list" };

    const git = names.indexOf("git");
    if (git >= 0) {
      const push = words.indexOf("push", git + 1);
      if (push >= 0 && isForcePush(words.slice(push + 1))) return { reason: "deny-list" };
    }

    for (let i = 0; i < names.length; i += 1) {
      const name = names[i];
      if (name !== undefined && INSTALL_TOOLS.has(name)) {
        if (words.slice(i + 1).some((w) => INSTALL_SUBCOMMANDS.has(w.toLowerCase()))) {
          return { reason: "deny-list" };
        }
      }
    }
  }
  // Downloader plus shell anywhere in one command: covers `curl … | sh`, `sh -c "$(curl …)"`,
  // `bash <(curl …)`. Broader than the pipe alone on purpose (fail closed).
  if (sawDownloader && sawShell) return { reason: "deny-list" };
  return undefined;
}
