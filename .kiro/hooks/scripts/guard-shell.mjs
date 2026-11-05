#!/usr/bin/env node
// PreToolUse guard for shell tools. Reads the hook event JSON from stdin
// ({ hook_event_name, cwd, tool_name, tool_input: { command } }) and exits 2
// with a reason on stderr to block the call, or 0 to allow it.
// No dependencies; works on macOS, Linux and Windows.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REMOVABLE_DIRS = new Set(["node_modules", "dist", ".turbo"]);
const DEVICE_PATHS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/stdin"]);
const SAFE_ENV_SUFFIXES = [".example", ".sample", ".template"];
const SECRET_FILE = /(^|[\\/])(\.env(\.[\w.-]+)?|\.npmrc|\.netrc|\.pgpass|id_(rsa|ed25519|ecdsa)|credentials\.json|[\w.-]+\.(pem|key|p12|pfx))$|[\\/]\.aws[\\/]credentials$/i;
const SECRET_VAR = /\$\{?[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*\}?/;

const readStdin = () => {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
};

/** Pull the shell command out of the hook payload; tolerate unknown shapes. */
const extractCommand = (raw) => {
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return { command: raw.trim(), cwd: process.cwd() };
  }
  const input = event?.tool_input ?? event?.toolInput ?? {};
  const candidates = typeof input === "string" ? [input] : [input.command, input.cmd, input.script, input.commandLine];
  const command = candidates.find((c) => typeof c === "string") ?? "";
  const cwd = typeof event?.cwd === "string" && event.cwd !== "" ? event.cwd : process.cwd();
  return { command, cwd };
};

/** Minimal POSIX-ish tokenizer: splits into simple commands and unquoted words. */
const tokenize = (command) => {
  const commands = [];
  let words = [];
  let word = "";
  let hasWord = false;
  let quote = null;
  const pushWord = () => {
    if (hasWord) words.push(word);
    word = "";
    hasWord = false;
  };
  const pushCommand = () => {
    pushWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasWord = true;
    } else if (ch === "\\" && i + 1 < command.length) {
      word += command[++i];
      hasWord = true;
    } else if (ch === ";" || ch === "|" || ch === "&" || ch === "\n" || ch === "(" || ch === ")" || ch === "`") {
      pushCommand();
    } else if (/\s/.test(ch)) {
      pushWord();
    } else {
      word += ch;
      hasWord = true;
    }
  }
  pushCommand();
  return commands;
};

const stripPrefixes = (words) => {
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || ["sudo", "command", "exec", "nohup", "time", "xargs"].includes(words[i]))) i++;
  return words.slice(i);
};

const shortFlags = (words) => words.filter((w) => /^-[A-Za-z]+$/.test(w)).join("").replace(/-/g, "");

const isInside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

const expandHome = (p) => {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return p.replace(/^(~|\$HOME|\$\{HOME\}|%USERPROFILE%)(?=$|[\\/])/, home);
};

/** Returns a reason string when a word points outside the repository root. */
const outsideRepo = (word, cwd) => {
  const value = word.includes("=") && word.startsWith("-") ? word.slice(word.indexOf("=") + 1) : word;
  if (value === "" || /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || DEVICE_PATHS.has(value)) return null;
  const looksHome = /^(~|\$HOME|\$\{HOME\}|%USERPROFILE%)(?=$|[\\/])/.test(value);
  const looksAbsolute = path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
  const climbs = /(^|[\\/])\.\.([\\/]|$)/.test(value);
  if (!looksHome && !looksAbsolute && !climbs) return null;
  const resolved = path.resolve(cwd, expandHome(value));
  if (isInside(resolved, REPO_ROOT)) return null;
  // Absolute-looking words that are not real paths (e.g. "/api/" in a grep) are allowed.
  if (looksAbsolute && !looksHome) {
    const top = resolved.split(path.sep).slice(0, 2).join(path.sep) || path.sep;
    if (!existsSync(top)) return null;
  }
  return `path "${word}" resolves outside the repository root (${REPO_ROOT})`;
};

const isRemovableTarget = (target, cwd) => {
  const resolved = path.resolve(cwd, expandHome(target));
  if (!isInside(resolved, REPO_ROOT) || resolved === REPO_ROOT) return false;
  return path.relative(REPO_ROOT, resolved).split(path.sep).some((seg) => REMOVABLE_DIRS.has(seg));
};

const checkSimpleCommand = (rawWords, cwd) => {
  const words = stripPrefixes(rawWords);
  const [cmd = "", sub = ""] = words;
  const name = path.basename(cmd);
  const args = words.slice(1);

  if (name === "rm") {
    const flags = shortFlags(args);
    const recursive = flags.includes("r") || flags.includes("R") || args.includes("--recursive");
    const force = flags.includes("f") || args.includes("--force");
    if (recursive && force) {
      const targets = args.filter((a) => !a.startsWith("-"));
      const bad = targets.filter((t) => !isRemovableTarget(t, cwd));
      if (targets.length === 0 || bad.length > 0) {
        return `"rm -rf" is only allowed on node_modules, dist or .turbo inside the repo (blocked target: ${bad.join(" ") || "<none>"})`;
      }
    }
  }

  if (name === "git") {
    const gitArgs = words.slice(1).filter((w, i, all) => !(all[i - 1] === "-C" || all[i - 1] === "-c" || w === "-C" || w === "-c"));
    const action = gitArgs[0] ?? sub;
    const rest = gitArgs.slice(1);
    if (action === "push" && (rest.some((a) => a.startsWith("--force")) || shortFlags(rest).includes("f") || rest.some((a) => /^\+[^\s]/.test(a)))) {
      return '"git push --force" rewrites shared history; push normally or ask the human';
    }
    if (action === "reset" && rest.includes("--hard")) return '"git reset --hard" discards work; use "git stash" or ask the human';
    if (action === "clean") {
      const flags = shortFlags(rest);
      const dryRun = flags.includes("n") || rest.includes("--dry-run");
      if (!dryRun && (flags.includes("f") || rest.includes("--force"))) return '"git clean -f/-fdx" deletes untracked files; use "git clean -n" to preview and ask the human';
    }
  }

  if (["printenv", "env", "set", "export"].includes(name) && args.length === 0) {
    return `"${name}" without arguments dumps environment variables, which may contain secrets`;
  }

  for (const word of words) {
    if (SECRET_FILE.test(word) && !SAFE_ENV_SUFFIXES.some((s) => word.endsWith(s))) {
      return `access to secret file "${word}" is not allowed; secrets must never be printed or copied`;
    }
  }
  if (["echo", "printf", "print", "write-host", "write-output"].includes(name.toLowerCase())) {
    const leak = args.find((a) => SECRET_VAR.test(a));
    if (leak !== undefined) return `printing secret variable "${leak}" is not allowed`;
  }

  for (const word of words) {
    const reason = outsideRepo(word, cwd);
    if (reason !== null) return reason;
  }
  return null;
};

export const evaluate = (command, cwd) => {
  if (command.trim() === "") return null;
  if (/\b(curl|wget|iwr|Invoke-WebRequest|irm|Invoke-RestMethod)\b[^|]*\|\s*(sudo\s+)?(ba|z|da|k|fi)?sh\b|\b(curl|wget|iwr|irm)\b[^|]*\|\s*(iex|Invoke-Expression|node|python3?|perl|ruby)\b/i.test(command)) {
    return "piping a downloaded script into an interpreter (curl | sh) is not allowed";
  }
  if (/(ba|z)?sh\s+(-c\s+)?["']?\$\(\s*(curl|wget)|(ba|z)?sh\s+<\(\s*(curl|wget)/i.test(command)) {
    return "executing a downloaded script (sh -c \"$(curl …)\") is not allowed";
  }
  for (const words of tokenize(command)) {
    const reason = checkSimpleCommand(words, cwd);
    if (reason !== null) return reason;
  }
  return null;
};

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { command, cwd } = extractCommand(readStdin());
  const reason = evaluate(command, cwd);
  if (reason !== null) {
    process.stderr.write(`Blocked by .kiro/hooks/guard-shell: ${reason}.\nCommand: ${command}\n`);
    process.exit(2);
  }
  process.exit(0);
}
