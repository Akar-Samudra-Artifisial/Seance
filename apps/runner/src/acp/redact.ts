// Secret redaction for logs (Req 2.10). All functions are idempotent.

export const REDACTED = "[REDACTED]";

const SECRET_WORDS = "token|secret|password|authorization|api[_-]?key|credential";
const SECRET_KEY_LINE = new RegExp(`"([^"]*(?:${SECRET_WORDS})[^"]*)"\\s*:\\s*"[^"]*"`, "gi");
const SECRET_KEY_NAME = new RegExp(SECRET_WORDS, "i");

/** Redacts string values of secret-looking keys in a JSON line (the spike's redact). */
export const redact = (line: string): string => line.replace(SECRET_KEY_LINE, `"$1":"${REDACTED}"`);

const isPlainObject = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Returns a deep copy where every value under a secret-looking key (any case, any depth) is replaced. */
export const redactJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((item: unknown) => redactJson(item));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SECRET_KEY_NAME.test(key) ? REDACTED : redactJson(inner);
    }
    return out;
  }
  return value;
};

/** Replaces every occurrence of each known secret value (for example KIRO_API_KEY) in text. */
export const redactValues = (text: string, secrets: readonly (string | undefined)[]): string => {
  const known = secrets.filter((s): s is string => s !== undefined && s.length > 0);
  if (known.length === 0) return text;
  // Split on the marker so a short secret cannot match inside an earlier replacement.
  return text
    .split(REDACTED)
    .map((part) => known.reduce((acc, secret) => acc.split(secret).join(REDACTED), part))
    .join(REDACTED);
};
