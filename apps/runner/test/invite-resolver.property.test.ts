import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { irc_lower } from "@seance/irc-protocol";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseInviters } from "../src/invite/allow-list.js";
import { BanList } from "../src/invite/ban-list.js";
import { createInviteResolver } from "../src/invite/resolver.js";
import type { RunnerLogger } from "../src/log.js";
import { AgentRegistry } from "../src/registry/agent-registry.js";

/**
 * P9: the invite resolver claims exactly registered, unbanned, permitted nicks and leaves no state.
 * **Validates: Requirements 3.1, 3.14, 3.15, 9.10, 9.11**
 */
const TAG =
  "Feature: agent-runner, Property 9: the invite resolver claims exactly registered, unbanned, permitted nicks and leaves no state";
const RUNS = { numRuns: 300 } as const;

const REGISTERED = ["Co[d]er", "Re\\v|x", "Spy^1"] as const;

const silent: RunnerLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

let dir = "";
const registries: AgentRegistry[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "seance-p9-"));
  for (let size = 1; size <= REGISTERED.length; size += 1) {
    const sub = join(dir, `r${size}`);
    await mkdir(sub);
    for (const [i, nick] of REGISTERED.slice(0, size).entries()) {
      await writeFile(
        join(sub, `${i}.json`),
        JSON.stringify({ nick, kiroAgent: `agent${i}`, model: "m", tools: "read", color: i }),
      );
    }
    registries.push(await AgentRegistry.load(sub, silent));
  }
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------- generators ----------

const NICK_FIRST = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const NICK_REST = `${NICK_FIRST}0123456789-[]\\\`^{}|_`;
const validNickArb = fc
  .tuple(
    fc.constantFrom(...NICK_FIRST),
    fc.array(fc.constantFrom(...NICK_REST), { maxLength: 8 }),
  )
  .map(([first, rest]) => first + rest.join(""));

// Multi-byte and arbitrary strings count as (invalid) nicks.
const weirdNickArb = fc.oneof(
  fc.string({ unit: "binary", maxLength: 12 }),
  fc.constantFrom("", "日本語", "😀x", "e\u0301", "a b", "#chan"),
);

const SWAP: Readonly<Record<string, string>> = {
  "[": "{",
  "]": "}",
  "\\": "|",
  "~": "^",
  "{": "[",
  "}": "]",
  "|": "\\",
  "^": "~",
};

/** Re-cases letters and swaps the rfc1459 pairs `[]\~` ↔ `{}|^`. */
const variantArb = (nick: string): fc.Arbitrary<string> =>
  fc.array(fc.boolean(), { minLength: nick.length, maxLength: nick.length }).map((mask) =>
    [...nick]
      .map((ch, i) => {
        if (mask[i] !== true) return ch;
        const swapped = SWAP[ch];
        if (swapped !== undefined) return swapped;
        return ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase();
      })
      .join(""),
  );

const registeredVariantArb = fc
  .constantFrom(...REGISTERED)
  .chain((nick) => variantArb(nick));

const targetArb = fc.oneof(
  registeredVariantArb,
  registeredVariantArb,
  validNickArb,
  weirdNickArb,
);

const channelArb = fc.oneof(
  fc.constantFrom("#a", "#A", "#chan[1]", "#CHAN{1}", "#日本"),
  validNickArb.map((n) => `#${n}`),
);

const banNickArb = fc.oneof(registeredVariantArb, validNickArb);

const scenarioArb = fc.record({
  registryIndex: fc.integer({ min: 0, max: REGISTERED.length - 1 }),
  target: targetArb,
  channel: channelArb,
  bans: fc.array(fc.tuple(channelArb, banNickArb), { maxLength: 6 }),
  allow: fc.option(fc.array(validNickArb, { maxLength: 4 }), { nil: undefined }),
  inviterPick: fc.nat(),
  inviterFresh: validNickArb,
  inviterMode: fc.constantFrom("member", "variant", "fresh"),
  inviterVariantSeed: fc.integer(),
});

describe("P9 invite resolver claim rule", () => {
  it(TAG, () => {
    fc.assert(
      fc.property(
        scenarioArb,
        // A bans entry that collides with the target in this channel (to exercise both outcomes).
        fc.boolean(),
        (s, banTarget) => {
          const registry = registries[s.registryIndex];
          expect(registry).toBeDefined();
          if (registry === undefined) return;

          const bans = new BanList();
          for (const [ch, nick] of s.bans) bans.add(ch, nick);
          if (banTarget) bans.add(s.channel, s.target);

          const allowEntries = s.allow;
          const inviters = parseInviters(allowEntries);

          // Inviter: a listed nick (possibly re-cased) or an unrelated one.
          let inviter = s.inviterFresh;
          if (allowEntries !== undefined && allowEntries.length > 0 && s.inviterMode !== "fresh") {
            const base = allowEntries[s.inviterPick % allowEntries.length] ?? s.inviterFresh;
            inviter =
              s.inviterMode === "variant"
                ? [...base]
                    .map((ch, i) => {
                      if ((s.inviterVariantSeed >> i) % 2 === 0) return ch;
                      return SWAP[ch] ?? (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase());
                    })
                    .join("")
                : base;
          }

          // Reference model, derived from the raw inputs.
          const registered = new Set(
            registry.all().map((p) => irc_lower(p.nick)),
          );
          const banned = new Set(
            [...s.bans, ...(banTarget ? [[s.channel, s.target] as const] : [])].map(
              ([ch, nick]) => `${irc_lower(ch)}\0${irc_lower(nick)}`,
            ),
          );
          const permitted =
            allowEntries === undefined || allowEntries.length === 0
              ? true
              : allowEntries.some((n) => irc_lower(n) === irc_lower(inviter));
          const expected =
            registered.has(irc_lower(s.target)) &&
            !banned.has(`${irc_lower(s.channel)}\0${irc_lower(s.target)}`) &&
            permitted;

          // Observable state before the calls.
          const probes: readonly (readonly [string, string])[] = [
            [s.channel, s.target],
            ...s.bans,
            ...REGISTERED.map((n) => [s.channel, n] as const),
          ];
          const snapshot = (): unknown =>
            structuredClone({
              registry: registry.all(),
              bans: probes.map(([ch, nick]) => bans.has(ch, nick)),
              allows: [inviter, ...(allowEntries ?? [])].map((n) => inviters.allows(n)),
              allowEntries,
            });
          const before = snapshot();

          const resolve = createInviteResolver({ registry, bans, inviters });
          const first = resolve(s.target, s.channel, inviter);
          const second = resolve(s.target, s.channel, inviter);
          const third = resolve(s.target, s.channel, inviter);

          expect(typeof first).toBe("boolean");
          expect((first as unknown as { then?: unknown }).then).toBeUndefined();
          expect(first).toBe(expected);
          expect(second).toBe(expected);
          expect(third).toBe(expected);
          expect(snapshot()).toEqual(before);
        },
      ),
      RUNS,
    );
  });
});
