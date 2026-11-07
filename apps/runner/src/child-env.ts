/**
 * Allow-listed environment for child processes. The runner's own environment may hold database URLs,
 * tokens and other secrets that a child (an agent or git hook) must never inherit.
 */
export type EnvLike = Readonly<Record<string, string | undefined>>;

const ALLOWED_NAMES: ReadonlySet<string> = new Set(["PATH", "HOME", "LANG", "TERM", "TMPDIR"]);

const isAllowed = (name: string): boolean => ALLOWED_NAMES.has(name) || name.startsWith("LC_");

/** Copies only PATH, HOME, LANG, LC_*, TERM and TMPDIR (set, string values) from `source`. */
export function allowListedEnv(source: EnvLike): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && isAllowed(name)) out[name] = value;
  }
  return out;
}
