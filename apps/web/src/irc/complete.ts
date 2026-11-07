import { irc_lower } from "./casemap.js";

/** State carried between Tab presses so repeated presses cycle through the matches. */
export interface CompletionCycle {
  /** Index in `input` where the completed word starts. */
  readonly start: number;
  /** Text inserted by the previous call (nick plus any suffix). */
  readonly inserted: string;
  /** Matching nicks, in cycle order. */
  readonly matches: readonly string[];
  /** Index into `matches` of the nick currently inserted. */
  readonly index: number;
}

export interface Completion {
  readonly input: string;
  readonly caret: number;
  /** Pass back as `cycle` on the next Tab press; null when nothing was completed. */
  readonly cycle: CompletionCycle | null;
}

const START_SUFFIX = ": ";

function insertion(nick: string, start: number): string {
  return start === 0 ? nick + START_SUFFIX : nick;
}

/**
 * Complete the word before `caret` with a nick whose rfc1459-lowered form starts with the
 * lowered word. Repeated calls with the returned `cycle` step through the other matches.
 * A nick completed at the start of the line gets `: ` appended. Pure: inputs are not mutated.
 */
export function completeNick(
  input: string,
  caret: number,
  nicks: readonly string[],
  cycle: CompletionCycle | null,
): Completion {
  const at = Math.max(0, Math.min(caret, input.length));

  if (cycle !== null && cycle.matches.length > 0) {
    const end = cycle.start + cycle.inserted.length;
    if (at === end && input.slice(cycle.start, end) === cycle.inserted) {
      const index = (cycle.index + 1) % cycle.matches.length;
      const nick = cycle.matches[index] as string;
      const inserted = insertion(nick, cycle.start);
      return {
        input: input.slice(0, cycle.start) + inserted + input.slice(end),
        caret: cycle.start + inserted.length,
        cycle: { start: cycle.start, inserted, matches: cycle.matches, index },
      };
    }
  }

  const before = input.slice(0, at);
  const start = Math.max(before.lastIndexOf(" "), before.lastIndexOf("\t")) + 1;
  const word = before.slice(start);
  if (word === "") return { input, caret: at, cycle: null };

  const key = irc_lower(word);
  const seen = new Set<string>();
  const matches: string[] = [];
  for (const nick of nicks) {
    const lowered = irc_lower(nick);
    if (lowered.startsWith(key) && !seen.has(lowered)) {
      seen.add(lowered);
      matches.push(nick);
    }
  }
  if (matches.length === 0) return { input, caret: at, cycle: null };

  const inserted = insertion(matches[0] as string, start);
  return {
    input: input.slice(0, start) + inserted + input.slice(at),
    caret: start + inserted.length,
    cycle: { start, inserted, matches, index: 0 },
  };
}
