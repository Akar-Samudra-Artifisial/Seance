export type LogFields = Readonly<Record<string, unknown>>;

export interface RunnerLogger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

const SECRET_NAME = /token|secret|password|authorization|api[_-]?key|credential/i;
const REDACTED = "[REDACTED]";
const MAX_DEPTH = 8;

const redactValue = (value: unknown, depth: number): unknown => {
  if (depth > MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (typeof value === "object" && value !== null) {
    return redactFields(value as LogFields, depth + 1);
  }
  return value;
};

/**
 * Returns a copy of `fields` where the value of every secret-looking key
 * (token, secret, password, authorization, api key, credential) is replaced
 * by `[REDACTED]`, at any depth. The input is never mutated.
 */
export const redactFields = (
  fields: LogFields,
  depth = 0,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = SECRET_NAME.test(key) ? REDACTED : redactValue(value, depth);
  }
  return out;
};
