import { isValidNick } from "@seance/irc-protocol";

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
export const parseProfile = (json: unknown, file: string): AgentProfile => {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new AgentProfileError(file, "(root)", "must be a JSON object");
  }
  const obj = json as Readonly<Record<string, unknown>>;

  const nick = readString(obj, file, "nick", 30);
  if (!isValidNick(nick)) {
    throw new AgentProfileError(file, "nick", `"${nick}" is not a valid IRC nick`);
  }
  const kiroAgent = readString(obj, file, "kiroAgent", MAX_LENGTHS.kiroAgent);
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

  return { nick, kiroAgent, model, tools, color, file };
};
