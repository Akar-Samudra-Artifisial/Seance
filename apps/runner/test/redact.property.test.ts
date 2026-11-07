import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { REDACTED, redact, redactJson, redactValues } from "../src/acp/redact.js";

/**
 * P12: redaction removes secret values and is idempotent.
 * **Validates: Requirements 2.10**
 */
const TAG = "Feature: agent-runner, Property 12: redaction removes secret values and is idempotent";
const RUNS = { numRuns: 200 } as const;

// ---------- generators ----------

const SECRET_WORDS = ["token", "secret", "password", "authorization", "api_key", "apiKey", "credential"] as const;
const NEUTRAL_KEYS = ["id", "method", "cwd", "name", "count", "path", "params", "result", "日本"] as const;
const NEUTRAL_STRINGS = ["ok", "main", "hello world", "日本語", "😀 hi", "/w/ch/src"] as const;

const MARKER_PREFIX = "S3c-";
const ALNUM = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"] as const;

/** Secret values carry a unique prefix, so they never occur inside a neutral value or key. */
const markerArb = fc
  .array(fc.constantFrom(...ALNUM), { minLength: 8, maxLength: 24 })
  .map((chars) => `${MARKER_PREFIX}${chars.join("")}`);

/** A secret word in random letter case, with an optional prefix and suffix. */
const secretKeyArb = fc
  .tuple(
    fc.constantFrom(...SECRET_WORDS),
    fc.array(fc.boolean(), { minLength: 16, maxLength: 16 }),
    fc.constantFrom("", "x_", "my", "X-"),
    fc.constantFrom("", "_v2", "Value", "-1"),
  )
  .map(([word, flips, prefix, suffix]) => {
    const cased = [...word].map((c, i) => (flips[i] === true ? c.toUpperCase() : c.toLowerCase())).join("");
    return `${prefix}${cased}${suffix}`;
  });

const neutralKeyArb = fc.constantFrom(...NEUTRAL_KEYS);
const neutralLeafArb = fc.oneof(
  fc.constantFrom(...NEUTRAL_STRINGS),
  fc.integer(),
  fc.boolean(),
  fc.constant(null),
);

/** Secret values may be strings, arrays or objects holding only markers. */
const richSecretValueArb: fc.Arbitrary<unknown> = fc.oneof(
  markerArb,
  fc.array(markerArb, { maxLength: 3 }),
  fc.dictionary(neutralKeyArb, markerArb, { maxKeys: 3 }),
);

/** Trees whose secret keys sit at any depth; `secretValueArb` decides what hides under them. */
const treeArb = (secretValueArb: fc.Arbitrary<unknown>): fc.Arbitrary<unknown> =>
  fc.letrec<{ node: unknown }>((tie) => ({
    node: fc.oneof(
      { depthSize: "small", maxDepth: 4 },
      neutralLeafArb,
      fc.array(tie("node"), { maxLength: 3 }),
      fc.dictionary(neutralKeyArb, tie("node"), { maxKeys: 3 }),
      fc
        .tuple(secretKeyArb, secretValueArb, fc.dictionary(neutralKeyArb, tie("node"), { maxKeys: 3 }))
        .map(([key, value, rest]) => ({ ...rest, [key]: value })),
    ),
  })).node;

/** Safe KIRO_API_KEY values: at least 8 characters, no brackets, not a piece of the marker text. */
const apiKeyArb = fc
  .array(fc.constantFrom(...ALNUM, ..."-_=+/"), { minLength: 8, maxLength: 40 })
  .map((chars) => chars.join(""))
  .filter((key) => !REDACTED.includes(key));

// ---------- helpers ----------

const collectStrings = (value: unknown, out: string[] = []): string[] => {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
  else if (typeof value === "object" && value !== null) {
    for (const inner of Object.values(value)) collectStrings(inner, out);
  }
  return out;
};

const markers = (value: unknown): string[] => collectStrings(value).filter((s) => s.startsWith(MARKER_PREFIX));
const neutrals = (value: unknown): string[] => collectStrings(value).filter((s) => !s.startsWith(MARKER_PREFIX));

describe("P12 log redaction", () => {
  it(`${TAG} (redactJson, secret keys at any depth)`, () => {
    fc.assert(
      fc.property(treeArb(richSecretValueArb), (tree) => {
        const once = redactJson(tree);
        const text = JSON.stringify(once);
        for (const secret of markers(tree)) expect(text).not.toContain(secret);
        for (const keep of neutrals(tree)) expect(text).toContain(JSON.stringify(keep));
        expect(redactJson(once)).toEqual(once);
        expect(redactJson(tree)).toEqual(once); // input is not mutated
      }),
      RUNS,
    );
  });

  it(`${TAG} (redact, secret strings in a JSON line)`, () => {
    fc.assert(
      fc.property(treeArb(markerArb), (tree) => {
        const line = JSON.stringify(tree);
        const once = redact(line);
        for (const secret of markers(tree)) expect(once).not.toContain(secret);
        for (const keep of neutrals(tree)) expect(once).toContain(JSON.stringify(keep));
        expect(redact(once)).toBe(once);
      }),
      RUNS,
    );
  });

  it(`${TAG} (redactValues, KIRO_API_KEY in command lines, errors and JSON values)`, () => {
    fc.assert(
      fc.property(apiKeyArb, fc.constantFrom(...NEUTRAL_STRINGS), (key, neutral) => {
        const command = `kiro-cli acp --agent coder --api-key ${key} --note ${neutral}`;
        const error = `Error: authentication failed for ${key} (status 401) near ${neutral}`;
        const json = JSON.stringify({ message: `bad key ${key}`, again: key, note: neutral });
        for (const text of [command, error, json, `${command}\n${error}\n${json}`]) {
          const once = redactValues(text, [key, undefined]);
          expect(once).not.toContain(key);
          expect(once).toContain(REDACTED);
          expect(once).toContain(neutral);
          expect(redactValues(once, [key, undefined])).toBe(once);
        }
      }),
      RUNS,
    );
  });

  it(`${TAG} (redactValues without a key leaves text unchanged)`, () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(redactValues(text, [undefined, ""])).toBe(text);
      }),
      RUNS,
    );
  });
});
