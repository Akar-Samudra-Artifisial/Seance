import { isServiceNick, isValidNick } from "@seance/irc-protocol";

export type AgentProfile = {
  /** IRC nick, 1..30 chars, `isValidNick`. */
  readonly nick: string;
  /** Kiro agent name passed to `kiro-cli acp --agent`, 1..64 chars. */
  readonly kiroAgent: string;
  /** Model name shown in WHOIS, 1..64 chars. */
  readonly model: string;
  /** Tool summary shown in WHOIS, 1..256 chars. */
  readonly tools: string;
  /** IRC color, integer 0..15. */
  readonly color: number;
  /**
   * agent-skills Req 2: names of Kiro skills under `<agentsDir>/.kiro/skills/<name>/SKILL.md`.
   * `parseProfile` always sets it (`[]` when the file has none); optional in the type so profiles
   * built in code without skills stay valid. Shown in WHOIS; existence is checked by `verifyAgentFiles`.
   */
  readonly skills?: readonly string[];
  /** Source file, for error messages. */
  readonly file: string;
};

/** Thrown by `parseProfile`; names the file and the failing field. */
export class AgentProfileError extends Error {
  readonly file: string;
  readonly field: string;

  constructor(file: string, field: string, reason: string) {
    super(`Agent profile ${file} rejected: field "${field}" ${reason}`);
    this.name = "AgentProfileError";
    this.file = file;
    this.field = field;
  }
}

const MAX_LENGTHS = { kiroAgent: 64, model: 64, tools: 256 } as const;

/** agent-skills Req 2.2: a skill name is also its directory name under `.kiro/skills`. */
export const SKILL_NAME = /^[a-z0-9-]{1,40}$/;
export const MAX_SKILLS = 8;

const readSkills = (obj: Readonly<Record<string, unknown>>, file: string): readonly string[] => {
  const value = obj["skills"];
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new AgentProfileError(file, "skills", "must be an array of skill names");
  if (value.length > MAX_SKILLS) {
    throw new AgentProfileError(file, "skills", `must list at most ${MAX_SKILLS} skills, got ${value.length}`);
  }
  const seen = new Set<string>();
  for (const name of value as readonly unknown[]) {
    if (typeof name !== "string" || !SKILL_NAME.test(name)) {
      // The shown value is clipped: the profile file is local, but an error line should stay short.
      const shown = (JSON.stringify(name) ?? String(name)).slice(0, 60);
      throw new AgentProfileError(file, "skills", `entry ${shown} must match ${SKILL_NAME.source}`);
    }
    if (seen.has(name)) throw new AgentProfileError(file, "skills", `lists "${name}" twice`);
    seen.add(name);
  }
  return [...seen];
};

const readString = (
  obj: Readonly<Record<string, unknown>>,
  file: string,
  field: string,
  max: number,
): string => {
  const value = obj[field];
  if (value === undefined) throw new AgentProfileError(file, field, "is missing");
  if (typeof value !== "string") {
    throw new AgentProfileError(file, field, "must be a string");
  }
  if (value.length < 1 || value.length > max) {
    throw new AgentProfileError(file, field, `must be 1 to ${max} characters long`);
  }
  return value;
};

/**
 * Validates an already-parsed JSON value as an `AgentProfile`.
 * Throws `AgentProfileError` naming `file` and the first failing field.
 */
/** agent-sandbox Requirement 4.5: in podman mode `kiroAgent` can never be read as a flag. */
export const SANDBOX_KIRO_AGENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const parseProfile = (
  json: unknown,
  file: string,
  opts: { readonly sandboxed?: boolean } = {},
): AgentProfile => {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new AgentProfileError(file, "(root)", "must be a JSON object");
  }
  const obj = json as Readonly<Record<string, unknown>>;

  const nick = readString(obj, file, "nick", 30);
  if (!isValidNick(nick)) {
    throw new AgentProfileError(file, "nick", `"${nick}" is not a valid IRC nick`);
  }
  // runner-services Req 1.4: the services' nicks belong to the network.
  if (isServiceNick(nick)) {
    throw new AgentProfileError(file, "nick", `"${nick}" is reserved for network services`);
  }
  const kiroAgent = readString(obj, file, "kiroAgent", MAX_LENGTHS.kiroAgent);
  if (opts.sandboxed === true && !SANDBOX_KIRO_AGENT.test(kiroAgent)) {
    throw new AgentProfileError(file, "kiroAgent", "must match [A-Za-z0-9][A-Za-z0-9._-]{0,63} in podman mode");
  }
  const model = readString(obj, file, "model", MAX_LENGTHS.model);
  const tools = readString(obj, file, "tools", MAX_LENGTHS.tools);

  const color = obj["color"];
  if (color === undefined) throw new AgentProfileError(file, "color", "is missing");
  if (typeof color !== "number" || !Number.isInteger(color)) {
    throw new AgentProfileError(file, "color", "must be an integer");
  }
  if (color < 0 || color > 15) {
    throw new AgentProfileError(file, "color", "must be between 0 and 15");
  }

  const skills = readSkills(obj, file);

  return { nick, kiroAgent, model, tools, color, skills, file };
};
