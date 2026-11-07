import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { irc_lower } from "@seance/irc-protocol";
import type { RunnerLogger } from "../log.js";
import { AgentProfileError, parseProfile } from "./agent-profile.js";
import type { AgentProfile } from "./agent-profile.js";

/** No valid agent profile could be loaded; the runner must not start. */
export class NoAgentProfileError extends Error {
  constructor(dir: string, detail?: string) {
    super(
      `No agent profile is available in ${dir}${detail === undefined ? "" : `: ${detail}`}`,
    );
    this.name = "NoAgentProfileError";
  }
}

const describe = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

export class AgentRegistry {
  readonly #profiles: readonly AgentProfile[];
  readonly #byNick: ReadonlyMap<string, AgentProfile>;

  private constructor(profiles: readonly AgentProfile[]) {
    this.#profiles = profiles;
    this.#byNick = new Map(profiles.map((p) => [irc_lower(p.nick), p]));
  }

  /**
   * Loads `dir/*.json` (top level only, ascending filename order). Invalid
   * files are logged with file and field and skipped. Throws
   * `NoAgentProfileError` when no profile is valid.
   */
  static async load(dir: string, log: RunnerLogger): Promise<AgentRegistry> {
    let names: string[];
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      names = entries
        .filter((e) => e.isFile() && e.name.endsWith(".json"))
        .map((e) => e.name)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    } catch (err) {
      throw new NoAgentProfileError(dir, `cannot read directory (${describe(err)})`);
    }

    const accepted: AgentProfile[] = [];
    const seen = new Map<string, AgentProfile>();

    for (const name of names) {
      const file = join(dir, name);
      let profile: AgentProfile;
      try {
        let json: unknown;
        try {
          json = JSON.parse(await readFile(file, "utf8"));
        } catch (err) {
          throw new AgentProfileError(file, "(json)", `is not readable JSON: ${describe(err)}`);
        }
        profile = parseProfile(json, file);
      } catch (err) {
        if (err instanceof AgentProfileError) {
          log.error(err.message, { file: err.file, field: err.field });
        } else {
          log.error(`Agent profile ${file} rejected: ${describe(err)}`, { file });
        }
        continue;
      }

      const key = irc_lower(profile.nick);
      const earlier = seen.get(key);
      if (earlier !== undefined) {
        log.error(
          `Agent profile ${file} rejected: nick "${profile.nick}" duplicates "${earlier.nick}" from ${earlier.file}`,
          { file, field: "nick", otherFile: earlier.file },
        );
        continue;
      }
      seen.set(key, profile);
      accepted.push(profile);
    }

    if (accepted.length === 0) throw new NoAgentProfileError(dir);
    return new AgentRegistry(accepted);
  }

  lookup(nick: string): AgentProfile | undefined {
    return this.#byNick.get(irc_lower(nick));
  }

  all(): readonly AgentProfile[] {
    return this.#profiles;
  }
}
