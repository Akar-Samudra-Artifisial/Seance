// public-hardening design Property 1 (Requirements 1.1, 1.5, 2.3, 2.4, 2.5) and Property 3
// (Requirement 7.1), with fast-check.
import { isIP } from "node:net";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { irc_lower } from "@seance/irc-protocol";
import type { Accounts } from "../src/accounts.js";
import { ChannelRegistry } from "../src/channel-registry.js";
import type { Client } from "../src/client.js";
import { canonicalIp, clientIp } from "../src/client-ip.js";
import { CommandRouter } from "../src/command-router.js";
import type { RouterContext } from "../src/command-router.js";
import { ConnectionManager } from "../src/connection-manager.js";
import { registerRegistrationHandlers } from "../src/handlers/registration.js";

const PASSWORD = "guest-password";
const SECRET = "right-secret";
const ACCOUNT_NICKS = ["alice", "b[x]"] as const;
const AGENT_NICKS = ["coder", "reviewer"] as const;

/** Verification without scrypt: the property is about nick ownership, not hashing. */
const accounts: Accounts = {
  size: ACCOUNT_NICKS.length,
  has: (n) => ACCOUNT_NICKS.some((a) => irc_lower(a) === irc_lower(n)),
  nameOf: (n) => ACCOUNT_NICKS.find((a) => irc_lower(a) === irc_lower(n)),
  verify: (n, s) => Promise.resolve(ACCOUNT_NICKS.some((a) => irc_lower(a) === irc_lower(n)) && s === SECRET),
};

/** Case variants under rfc1459, including `[`/`{` and `]`/`}`. */
const NICK_POOL = [
  "alice",
  "ALICE",
  "Alice",
  "b[x]",
  "B{X}",
  "b{x]",
  "coder",
  "CODER",
  "Reviewer",
  "guest",
  "GUEST",
  "other",
] as const;

type Actor = "alice" | "bx" | "guestA" | "guestB" | "mallory" | "agent";
const ACTORS: readonly Actor[] = ["alice", "bx", "guestA", "guestB", "mallory", "agent"];

/** The PASS each actor sends: accounts their own login, guests the server password, mallory a forged one. */
const PASS_OF: Readonly<Record<Actor, string | undefined>> = {
  alice: `ALICE:${SECRET}`,
  bx: `B{X}:${SECRET}`,
  guestA: PASSWORD,
  guestB: PASSWORD,
  mallory: "alice:guessed",
  agent: undefined,
};

type Step =
  | { readonly actor: Actor; readonly kind: "pass" }
  | { readonly actor: Actor; readonly kind: "user" }
  | { readonly actor: Actor; readonly kind: "nick"; readonly nick: string };

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ actor: fc.constantFrom(...ACTORS), kind: fc.constant("pass" as const) }),
  fc.record({ actor: fc.constantFrom(...ACTORS), kind: fc.constant("user" as const) }),
  fc.record({ actor: fc.constantFrom(...ACTORS), kind: fc.constant("nick" as const), nick: fc.constantFrom(...NICK_POOL) }),
);

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const isAccountNick = (n: string): boolean => accounts.has(n);
const isAgentNick = (n: string): boolean => AGENT_NICKS.some((a) => irc_lower(a) === irc_lower(n));

describe("public-hardening properties", () => {
  it("P1 reserved nicks stay reserved", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 40 }), async (steps) => {
        const channels = new ChannelRegistry();
        const ctx: RouterContext = {
          connections: new ConnectionManager(channels.memberIdsLookup),
          channels,
          serverName: "irc.test",
          serverPassword: PASSWORD,
          accounts,
          reservedNicks: () => AGENT_NICKS,
          logger: { error: vi.fn() },
        };
        const router = new CommandRouter();
        registerRegistrationHandlers(router);
        const clients = new Map<Actor, Client>();
        for (const actor of ACTORS) {
          const client: Client = {
            id: actor,
            registered: false,
            host: "192.0.2.1",
            send: () => undefined,
            close: () => {
              ctx.connections.remove(actor);
            },
            ...(actor === "agent" ? { virtual: true, trusted: true } : {}),
          };
          ctx.connections.add(client);
          clients.set(actor, client);
        }
        for (const step of steps) {
          const client = clients.get(step.actor);
          if (client === undefined || ctx.connections.get(client.id) !== client) continue; // closed
          if (step.kind === "pass") {
            const pass = PASS_OF[step.actor];
            if (pass !== undefined) router.dispatch(ctx, client, { command: "PASS", params: [pass] });
          } else if (step.kind === "user") {
            router.dispatch(ctx, client, { command: "USER", params: ["u", "0", "*", "U"] });
          } else {
            router.dispatch(ctx, client, { command: "NICK", params: [step.nick] });
          }
          await flush();
          for (const c of ctx.connections.clients()) {
            if (c.trusted === true) continue;
            if (!c.registered) {
              // No nick is claimed before registration completes.
              expect(c.nick).toBeUndefined();
              continue;
            }
            const nick = c.nick ?? "";
            if (c.account !== undefined) {
              expect(irc_lower(nick)).toBe(irc_lower(c.account));
            } else {
              expect(isAccountNick(nick)).toBe(false);
              expect(isAgentNick(nick)).toBe(false);
            }
          }
          // A forged account login never registers as that account.
          const mallory = clients.get("mallory");
          expect(mallory?.account).toBeUndefined();
        }
      }),
      { numRuns: 150 },
    );
  });

  const ipv4 = fc.ipV4();
  const anyIp = fc.oneof(ipv4, fc.ipV6());
  const headerEntry = fc.oneof(anyIp, fc.constantFrom("", "unknown", "not-an-ip", " 10.0.0.1 "));

  it("P3 client IP", () => {
    fc.assert(
      fc.property(
        anyIp,
        fc.array(anyIp, { maxLength: 4 }),
        fc.option(fc.array(headerEntry, { minLength: 1, maxLength: 5 }), { nil: undefined }),
        fc.boolean(),
        (peer, others, entries, peerTrusted) => {
          const trusted = new Set([...others, ...(peerTrusted ? [peer] : [])].map(canonicalIp));
          const header = entries?.join(",");
          const result = clientIp(peer, header, trusted);
          const peerIp = canonicalIp(peer);
          if (!trusted.has(peerIp)) {
            expect(result).toBe(peerIp);
            return;
          }
          if (result === peerIp) return;
          expect(result).toBeDefined();
          expect(isIP(result ?? "")).not.toBe(0);
          expect(trusted.has(result ?? "")).toBe(false);
          const fromHeader = (header ?? "").split(",").map((e) => canonicalIp(e));
          expect(fromHeader).toContain(result);
        },
      ),
      { numRuns: 500 },
    );
  });
});
