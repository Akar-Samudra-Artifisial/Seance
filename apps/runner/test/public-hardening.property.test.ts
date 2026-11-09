// public-hardening design Property 2 (Requirement 6.2): redaction removes every variant and every
// fragment of 8 or more characters, also when the fragment is split over two lines of one Turn.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MIN_FRAGMENT, SecretRedactor, variantsOf } from "../src/output/secret-redactor.js";

const TOKEN_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.".split("");
/** Characters that appear in no variant (raw tokens, base64, base64url, hex). */
const PROSE_CHARS = " ,;:!?()äöüßéñ€\u3042".split("");

const secretArb = fc.array(fc.constantFrom(...TOKEN_CHARS), { minLength: 8, maxLength: 64 }).map((cs) => cs.join(""));
const proseArb = fc.array(fc.constantFrom(...PROSE_CHARS), { maxLength: 30 }).map((cs) => cs.join(""));

/** Every 8-character window of every variant of `secret`. */
function windowsOf(secret: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const v of variantsOf(secret)) {
    for (let i = 0; i + MIN_FRAGMENT <= v.length; i += 1) out.add(v.slice(i, i + MIN_FRAGMENT));
  }
  return out;
}

function containsWindow(text: string, windows: ReadonlySet<string>): boolean {
  for (let i = 0; i + MIN_FRAGMENT <= text.length; i += 1) if (windows.has(text.slice(i, i + MIN_FRAGMENT))) return true;
  return false;
}

/** A fragment of at least MIN_FRAGMENT characters of one variant of `secret`. */
const fragmentArb = (secret: string): fc.Arbitrary<string> =>
  fc.constantFrom(...variantsOf(secret)).chain((v) =>
    fc
      .integer({ min: 0, max: v.length - MIN_FRAGMENT })
      .chain((start) => fc.integer({ min: start + MIN_FRAGMENT, max: v.length }).map((end) => v.slice(start, end))),
  );

describe("public-hardening properties", () => {
  it("P2 redaction removes every variant and fragment", () => {
    fc.assert(
      fc.property(
        secretArb.chain((secret) =>
          fc.record({
            secret: fc.constant(secret),
            fragment: fragmentArb(secret),
            before: proseArb,
            after: proseArb,
            split: fc.option(fc.integer({ min: 1, max: 1000 }), { nil: undefined }),
            gap: fc.constantFrom("", " ", "\n"),
          }),
        ),
        ({ secret, fragment, before, after, split, gap }) => {
          const windows = windowsOf(secret);
          const r = new SecretRedactor([secret]);
          if (split === undefined) {
            const out = r.redact(`${before}${fragment}${after}`, "a\0#c");
            expect(containsWindow(out, windows)).toBe(false);
            return;
          }
          // Two adjacent lines of one Turn, split anywhere inside the fragment.
          const at = 1 + (split % (fragment.length - 1));
          const first = r.redact(`${before}${fragment.slice(0, at)}`, "a\0#c");
          const second = r.redact(`${gap}${fragment.slice(at)}${after}`, "a\0#c");
          expect(containsWindow(first, windows)).toBe(false);
          expect(containsWindow(second, windows)).toBe(false);
          expect(containsWindow(`${first}${second}`, windows)).toBe(false);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("P2 text without secret material is unchanged", () => {
    fc.assert(
      fc.property(secretArb, proseArb, (secret, text) => {
        expect(new SecretRedactor([secret]).redact(text, "a\0#c")).toBe(text);
      }),
      { numRuns: 300 },
    );
  });
});
