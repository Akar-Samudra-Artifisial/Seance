import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { irc_lower } from "@seance/irc-protocol";
import { sanitizeChannel } from "../src/worktree/sanitize.js";
import { resolveInside } from "../src/worktree/confine.js";

/**
 * P7: worktree path confinement.
 * **Validates: Requirements 4.11, 4.2, 4.3, 4.4**
 */
const TAG =
  "Feature: agent-runner, Property 7: the worktree path of any channel name is strictly inside the worktree root";

// ---------- generators ----------

const multiByteChar = fc.constantFrom("é", "ñ", "日", "本", "語", "😀", "👻", "\u0301", "ß");
const nameBody = fc.oneof(
  fc.string({ unit: "binary", maxLength: 80 }),
  fc.array(fc.oneof(multiByteChar, fc.constantFrom("/", "..", ".", "\0", " ", "~", "A", "Z", "[", "]", "\\", "-", "_")), {
    maxLength: 90,
  }).map((parts) => parts.join("")),
  fc.string({ minLength: 60, maxLength: 120 }),
);
const channelNameArb: fc.Arbitrary<string> = fc.oneof(
  nameBody.map((s) => `#${s}`),
  fc.string({ unit: "binary", maxLength: 300 }),
  fc.constantFrom("#..", "#../x", "#a/b", "#", "", "#\0", "#A", "#a", "#[x]", "#{x}", "#\\", "#|", ".", ".."),
);

const SWAP: Readonly<Record<string, string>> = { "[": "{", "]": "}", "\\": "|", "~": "^" };
const SWAP_BACK: Readonly<Record<string, string>> = { "{": "[", "}": "]", "|": "\\", "^": "~" };

/** `a` with letters re-cased and `[]\~` / `{}|^` swapped: same irc_lower. */
const equivalentPair = channelNameArb.chain((a) =>
  fc
    .array(fc.boolean(), { minLength: [...a].length, maxLength: [...a].length })
    .map((flips) => {
      const b = [...a]
        .map((ch, i) => {
          if (!flips[i]) return ch;
          if (ch in SWAP) return SWAP[ch] as string;
          if (ch in SWAP_BACK) return SWAP_BACK[ch] as string;
          // rfc1459 folds ASCII letters only; leave everything else untouched.
          if (ch >= "a" && ch <= "z") return ch.toUpperCase();
          if (ch >= "A" && ch <= "Z") return ch.toLowerCase();
          return ch;
        })
        .join("");
      return [a, b] as const;
    }),
);

/** `a` with one code point replaced (may or may not change irc_lower). */
const mutatedPair = fc
  .tuple(channelNameArb, fc.nat(), fc.oneof(multiByteChar, fc.string({ minLength: 1, maxLength: 1 })))
  .map(([a, idx, repl]) => {
    const chars = [...a];
    if (chars.length === 0) return [a, repl] as const;
    chars[idx % chars.length] = repl;
    return [a, chars.join("")] as const;
  });

const ALLOWED = /^[a-z0-9_-]{1,64}$/;

describe("P7 worktree path confinement", () => {
  it(`${TAG} (a) sanitized name is a safe single path component`, () => {
    fc.assert(
      fc.property(channelNameArb, (name) => {
        const s = sanitizeChannel(name);
        expect(s).toMatch(ALLOWED);
        expect(s).not.toBe(".");
        expect(s).not.toBe("..");
      }),
      { numRuns: 1000 },
    );
  });

  it(`${TAG} (b) joined path is strictly inside root with one relative segment`, () => {
    const root = join(sep, "w", "workspaces");
    fc.assert(
      fc.property(channelNameArb, (name) => {
        const p = join(root, sanitizeChannel(name));
        const rel = relative(root, p);
        expect(rel).not.toBe("");
        expect(rel).not.toBe("..");
        expect(rel.startsWith(`..${sep}`)).toBe(false);
        expect(isAbsolute(rel)).toBe(false);
        expect(rel.split(sep)).toHaveLength(1);
        expect(p.startsWith(root + sep)).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it(`${TAG} (c) equal sanitized names iff equal irc_lower names`, () => {
    fc.assert(
      fc.property(fc.oneof(equivalentPair, mutatedPair, fc.tuple(channelNameArb, channelNameArb)), ([a, b]) => {
        expect(sanitizeChannel(a) === sanitizeChannel(b)).toBe(irc_lower(a) === irc_lower(b));
      }),
      { numRuns: 1000 },
    );
    fc.assert(
      fc.property(equivalentPair, ([a, b]) => {
        expect(irc_lower(a)).toBe(irc_lower(b));
        expect(sanitizeChannel(a)).toBe(sanitizeChannel(b));
      }),
      { numRuns: 200 },
    );
  });

  it(`${TAG} (d) realpath of the created directory is strictly inside realpath(root)`, async () => {
    await fc.assert(
      fc.asyncProperty(channelNameArb, async (name) => {
        const base = await mkdtemp(join(tmpdir(), "seance-p7-"));
        try {
          const realRootDir = join(base, "real-root");
          const linkedRoot = join(base, "link-root");
          await mkdir(realRootDir);
          await symlink(realRootDir, linkedRoot, "dir");

          const dir = join(linkedRoot, sanitizeChannel(name));
          await mkdir(dir, { recursive: true });

          const realRoot = await realpath(linkedRoot);
          const realDir = await realpath(dir);
          const rel = relative(realRoot, realDir);
          expect(rel).not.toBe("");
          expect(rel.startsWith("..")).toBe(false);
          expect(isAbsolute(rel)).toBe(false);
          expect(rel.split(sep)).toHaveLength(1);
          expect(await resolveInside(linkedRoot, dir, name)).toBe(realDir);
        } finally {
          await rm(base, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 },
    );
  });
});
