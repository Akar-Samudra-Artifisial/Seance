/**
 * Pure deny list for shell tool calls (Requirement 8.7, 8.15).
 *
 * The list is a textual floor, not a sandbox. It never performs I/O and depends only on its
 * arguments. The protected-path reference check matches literal names only (after removing
 * quotes and backslashes, so `.k""iro` still counts); globs such as `.ki*` and constructed names
 * such as `$(printf '.ki%s' ro)` are not recognised and rely on the other layers (sparse-checkout,
 * pre-prompt scan, commit-diff check, container). The `rm -rf` escape check still treats a glob
 * that can match `..` conservatively.
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

/**
 * Literal match only (Req 8.15): a segment equal to `AGENTS.md` or `.kiro`, any letter case. A glob
 * segment (`*`, `.ki*`, `[Aa]GENTS.md`) is NOT treated as a reference: `find -not -path "./node_modules/*"`
 * is ordinary, and the pre-prompt scan plus the commit-diff check catch any file such a command creates.
 */
function segmentIsProtected(segment: string): boolean {
  return PROTECTED_NAMES.includes(segment.toLowerCase());
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
 * True when the command mentions `AGENTS.md` or `.kiro` (any letter case) literally as a token or
 * path segment. Glob segments never count.
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
  if (referencesAuthPath(command)) return { reason: "protected-path" };

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
  if (referencesKeyReader(command)) return { reason: "protected-path" };
  return undefined;
}

/**
 * public-hardening Requirement 6.3: the Kiro login inside the container. The auth mount, and the
 * copy the entrypoint stages into `$HOME` (kiro-cli keeps its state under `.local/share/kiro-cli`
 * and `.aws/sso`). Compared after removing quotes and backslashes, case-insensitively.
 */
export const AUTH_PATH_MARKERS: readonly string[] = ["/run/seance/auth", ".local/share/kiro-cli", ".aws/sso", ".aws/credentials"];

/** True when a shell command names the Kiro login in any of its known places (a textual floor). */
export function referencesAuthPath(command: string): boolean {
  const plain = command.replace(/["'\\]/g, "").toLowerCase();
  return AUTH_PATH_MARKERS.some((marker) => plain.includes(marker));
}

/** True when a resolved tool path is inside the Kiro login (any of the markers as path segments). */
export function isAuthPath(resolved: string): boolean {
  const p = resolved.replace(/\\/g, "/").toLowerCase();
  return AUTH_PATH_MARKERS.some((marker) => {
    const m = marker.toLowerCase();
    return p === m || p.startsWith(`${m}/`) || p.includes(`/${m.replace(/^\//, "")}/`) || p.endsWith(`/${m.replace(/^\//, "")}`);
  });
}

/** sandbox-api-key-auth Requirement 8: wrappers skipped before the command word, with their options. */
const KEY_READER_WRAPPERS: ReadonlySet<string> = new Set(["command", "exec", "sudo", "xargs", "nohup", "time", "builtin"]);
/** Wrapper options that take a separate argument word. */
const WRAPPER_OPTIONS_WITH_ARG: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    "sudo",
    new Set([
      "-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T",
      "--user", "--group", "--close-from", "--chdir", "--host", "--prompt",
      "--role", "--type", "--other-user", "--command-timeout",
    ]),
  ],
  ["exec", new Set(["-a"])],
  [
    "xargs",
    new Set([
      "-I", "-L", "-n", "-P", "-s", "-d", "-E", "-a",
      "--max-args", "--max-procs", "--delimiter", "--arg-file", "--max-lines", "--replace", "--eof",
    ]),
  ],
  ["time", new Set(["-f", "-o", "--format", "--output"])],
]);

/** Options of the env command that take a separate argument. */
const ENV_OPTIONS_WITH_ARG: ReadonlySet<string> = new Set(["-u", "--unset", "-C", "--chdir", "-S", "--split-string"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Index of the first word after the options and assignments of an env command; rest.length when none. */
function envCommandOperand(rest: readonly string[]): number {
  let j = 0;
  while (j < rest.length) {
    const w = rest[j] ?? "";
    if (w === "--") return j + 1;
    if (ENV_OPTIONS_WITH_ARG.has(w)) j += 2;
    else if (w.startsWith("-") || ASSIGNMENT.test(w)) j += 1;
    else return j;
  }
  return j;
}

/** Shells whose -c script is checked again for key readers (Requirement 13). */
const SCRIPT_SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh", "mksh", "ash", "fish"]);
/** How many levels of sh -c "sh -c ..." are looked into; deeper nesting is refused. */
const MAX_SCRIPT_DEPTH = 4;
/** A short option group that contains c (-c, -lc, -ec). */
const SHORT_C_OPTION = /^-[A-Za-z]*c[A-Za-z]*$/;

/** Quote-aware word split of one simple command; quotes and escaping backslashes are removed. */
function shellWords(part: string): readonly string[] {
  const words: string[] = [];
  let current = "";
  let present = false;
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < part.length; i += 1) {
    const ch = part[i] ?? "";
    if (quote === "'") {
      if (ch === "'") quote = undefined;
      else current += ch;
    } else if (quote === '"') {
      if (ch === '"') quote = undefined;
      else if (ch === "\\" && i + 1 < part.length) {
        i += 1;
        current += part[i] ?? "";
      } else current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      present = true;
    } else if (ch === "\\") {
      if (i + 1 < part.length) {
        i += 1;
        current += part[i] ?? "";
        present = true;
      }
    } else if (/\s/.test(ch)) {
      if (present || current !== "") words.push(current);
      current = "";
      present = false;
    } else {
      current += ch;
      present = true;
    }
  }
  if (present || current !== "") words.push(current);
  return words;
}

/** True when one simple command, quotes removed, prints the environment of the shell. */
function isKeyReaderWords(words: readonly string[], depth: number, piped = false): boolean {
  let i = 0;
  // Leading NAME=value assignments, then wrappers with their options; restart after each wrapper.
  for (;;) {
    while (i < words.length && ASSIGNMENT.test(words[i] ?? "")) i += 1;
    if (i < words.length && KEY_READER_WRAPPERS.has(baseName(words[i] ?? ""))) {
      const withArg = WRAPPER_OPTIONS_WITH_ARG.get(baseName(words[i] ?? ""));
      i += 1;
      while (i < words.length && (words[i] ?? "").startsWith("-")) {
        const opt = words[i] ?? "";
        i += 1;
        if (opt === "--") break;
        if (!opt.includes("=") && withArg?.has(opt)) i += 1;
      }
      continue;
    }
    break;
  }
  const word = words[i];
  if (word === undefined) return false;
  const rest = words.slice(i + 1);
  switch (baseName(word)) {
    case "printenv":
      return true;
    case "export":
    case "declare":
    case "typeset":
      // Without an operand these list variables (export -p, declare -x); export FOO=1 is harmless.
      return rest.every((w) => w.startsWith("-"));
    case "set":
      return rest.length === 0;
    case "env": {
      // With a command operand env runs that command; without one it prints the environment.
      const j = envCommandOperand(rest);
      return j >= rest.length || isKeyReaderWords(rest.slice(j), depth, piped);
    }
    case "eval":
      if (depth >= MAX_SCRIPT_DEPTH) return true; // fail closed
      return referencesKeyReader(rest.join(" "), depth + 1);
    default: {
      if (!SCRIPT_SHELLS.has(baseName(word))) return false;
      const c = rest.findIndex((w) => SHORT_C_OPTION.test(w));
      if (c < 0) {
        // No -c: a script file operand is not inspected; otherwise the shell reads its script from stdin.
        const operand = rest.find((w) => !w.startsWith("-") && !w.startsWith("+"));
        return operand === undefined ? piped : false;
      }
      const script = rest[c + 1];
      if (script === undefined) return false;
      if (depth >= MAX_SCRIPT_DEPTH) return true; // fail closed
      return referencesKeyReader(script, depth + 1);
    }
  }
}

/** Requirement 13.3, 13.4: a path segment that is a glob able to match `environ` (`envi*`, `env?ron`, `*`). */
function hasEnvironGlob(text: string): boolean {
  for (const token of text.split(REFERENCE_SPLIT)) {
    for (const segment of token.split(PATH_SPLIT)) {
      if (GLOB_CHARS.test(segment) && globMatches(segment, "environ")) return true;
    }
  }
  return false;
}

/**
 * Requirement 14.7, 14.8: true when some segment is `proc` (or a glob able to match it: `pr?c`,
 * `p*`, `[p]roc`) and a later segment is `environ` (or a glob able to match it). Pure; compares
 * lower-cased. Needs no literal `/proc`, so `/pr?c/self/environ` is caught.
 */
function segmentsReachEnviron(segments: readonly string[], absolute: boolean): boolean {
  // Only an absolute path can start at the proc mount; relative globs such as a leading `*` segment never do.
  if (!absolute) return false;
  const matches = (seg: string, name: string): boolean =>
    seg === name || (GLOB_CHARS.test(seg) && globMatches(seg, name));
  const parts = segments.filter((s) => s.length > 0).map((s) => s.toLowerCase());
  const [first, ...rest] = parts;
  if (first === undefined || !matches(first, "proc")) return false;
  return rest.some((seg) => matches(seg, "environ"));
}

/**
 * sandbox-api-key-auth Requirement 8.1, 8.2, 8.4: true when a shell command reads the process
 * environment, where KIRO_API_KEY lives. Covers env or printenv without a command, export -p,
 * declare -x, a bare set, any /proc/.../environ file, and the name KIRO_API_KEY itself.
 * Requirements 13.1, 13.2: the script inside sh -c and friends is checked up to MAX_SCRIPT_DEPTH
 * levels; deeper nesting is refused. A textual floor like referencesAuthPath: names built at run
 * time, interpreters such as python -c or node -e, and other encodings are not recognised.
 * Requirement 14.7: a token whose segments reach `environ` after a `proc` segment, either of them a
 * glob (such as `/pr?c/self/environ`), is refused without needing a literal `/proc`.
 */
export function referencesKeyReader(command: string, depth = 0): boolean {
  const plain = command.replace(/["'\\]/g, "").toLowerCase();
  if (plain.includes("kiro_api_key")) return true;
  if (plain.includes("/proc") && (plain.includes("environ") || hasEnvironGlob(plain))) return true;
  for (const token of plain.split(REFERENCE_SPLIT)) {
    if (segmentsReachEnviron(token.split(PATH_SPLIT), token.startsWith("/"))) return true;
  }
  // Odd indexes are separators. A part is "piped" when it reads a pipe or a here-string/document.
  const pieces = command.split(/([;&|<>()`{}\n]+)/);
  for (let k = 0; k < pieces.length; k += 2) {
    const piped = (pieces[k - 1] ?? "").includes("|") || (pieces[k + 1] ?? "").startsWith("<<");
    if (isKeyReaderWords(shellWords(pieces[k] ?? ""), depth, piped)) return true;
  }
  return false;
}

/**
 * Requirement 8.3, 13.3, 13.4: any environ file under a proc directory (/proc/self/environ,
 * /proc/1/task/2/environ), including a last segment that is a glob able to match `environ`
 * (/proc/self/envi*, /proc/1/*).
 * Requirement 14.8: the proc and environ segments may themselves be globs
 * (/pr?c/self/environ, /[p]roc/1/environ).
 */
export function isEnvironPath(path: string): boolean {
  const p = path.replace(/\\/g, "/").toLowerCase();
  if (/(^|\/)proc\/(.+\/)?environ(\/|$)/.test(p)) return true;
  const segments = p.split("/").filter((s) => s.length > 0);
  if (segmentsReachEnviron(segments, p.startsWith("/"))) return true;
  const last = segments[segments.length - 1];
  if (last === undefined || segments.indexOf("proc") >= segments.length - 1) return false;
  return segments.indexOf("proc") >= 0 && GLOB_CHARS.test(last) && globMatches(last, "environ");
}
