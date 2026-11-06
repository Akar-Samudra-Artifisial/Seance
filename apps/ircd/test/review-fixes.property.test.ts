import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { serialize, type IrcMessage } from "@seance/irc-protocol";
import { clampTrailing, MAX_LINE_BYTES } from "../src/text-limits.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { safeEqual } from "../src/handlers/registration.js";
import { ConnectionSession } from "../src/network-client.js";
import type { Wire } from "../src/network-client.js";
import { ConnectionGate, DEFAULT_LIMITS } from "../src/limits.js";
import { TokenBucket } from "../src/token-bucket.js";
import { isOriginAllowed } from "../src/origin.js";
import { ChannelRegistry } from "../src/channel-registry.js";
import { ConnectionManager } from "../src/connection-manager.js";
import { EventBus } from "../src/event-bus.js";
import { createRouter } from "../src/server.js";
import { createVirtualClient } from "../src/virtual-client.js";
import type { RouterContext } from "../src/command-router.js";
import type { TimerApi } from "../src/connection-manager.js";

const USERNAME_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~-";

// Independent oracle for the documented rules (Req 4.1, 4.2).
function expectedValid(user: string, realname: string): boolean {
  if (user.length < 1 || user.length > 18) return false;
  for (const ch of user) if (!USERNAME_CHARS.includes(ch)) return false;
  if (Buffer.byteLength(realname, "utf8") > 50) return false;
  for (const ch of realname) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x1f || cp === 0x7f) return false;
  }
  return true;
}

function register(user: string, realname: string): { welcomed: boolean; closed: boolean } {
  const server = createServer(loadConfig({}), { error: () => {} });
  const c = server.createVirtualClient({ id: "u" });
  const msgs: IrcMessage[] = [];
  c.onMessage((m) => msgs.push(m));
  c.dispatch({ command: "NICK", params: ["nick"] });
  c.dispatch({ command: "USER", params: [user, "0", "*", realname] });
  return {
    welcomed: msgs.some((m) => m.command === "001"),
    closed: server.ctx.connections.get("u") === undefined,
  };
}

// Generators stay wire-reachable: a USER param cannot be empty, contain a space or CR/LF/NUL.
// Mostly-valid characters with some invalid ones, so both outcomes are common.
const userChar = fc.oneof(
  { weight: 9, arbitrary: fc.constantFrom(...USERNAME_CHARS) },
  { weight: 1, arbitrary: fc.constantFrom("!", "@", "ü", "é", "\u0001", "#", "\u{1F47B}") },
);
const username = fc
  .array(userChar, { minLength: 1, maxLength: 22 })
  .map((a) => a.join(""));

const realChar = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom("a", "Z", " ", "-", "7") },
  { weight: 3, arbitrary: fc.constantFrom("é", "日", "\u{1F47B}") },
  { weight: 1, arbitrary: fc.constantFrom("\u0001", "\u0007", "\t", "\u001f", "\u007f") },
);
const realname = fc
  .array(realChar, { minLength: 0, maxLength: 60 })
  .map((a) => a.join(""));

describe("RF-P5 USER validation", () => {
  it("RF-P5 registration succeeds iff username and real name satisfy the documented rules", () => {
    // **Validates: Requirements 4.1, 4.2, 4.4**
    fc.assert(
      fc.property(username, realname, (user, real) => {
        const r = register(user, real);
        const ok = expectedValid(user, real);
        expect(r.welcomed).toBe(ok);
        expect(r.closed).toBe(!ok);
      }),
      { numRuns: 300 },
    );
  });
});

// Wire-reachable pieces: prefix and leading params have no space, CR, LF or NUL.
const wireChar = fc.constantFrom(..."abcXYZ019.-_[]!@é日\u{1F47B}");
const wireWord = (min: number, max: number) =>
  fc.array(wireChar, { minLength: min, maxLength: max }).map((a) => a.join(""));
// Trailing text: any Unicode (astral and combining marks included), minus CR/LF/NUL.
const trailingText = fc
  .string({ unit: "grapheme", maxLength: 700 })
  .map((s) => s.replace(/[\r\n\0]/g, ""));
const relayCommand = fc.constantFrom("PRIVMSG", "NOTICE", "PART", "KICK", "TOPIC", "QUIT", "322", "332");

describe("RF-P2/RF-P3 relayed text clamp", () => {
  it("RF-P2/RF-P3 relayed line fits 512 bytes, clamp is a whole-code-point prefix and idempotent", () => {
    // **Validates: Requirements 2.1, 2.5, 2.6**
    fc.assert(
      fc.property(
        fc.option(wireWord(1, 120), { nil: undefined }),
        relayCommand,
        fc.array(wireWord(1, 40), { maxLength: 3 }),
        trailingText,
        (prefix, command, leading, text) => {
          const clamped = clampTrailing(prefix, command, leading, text);

          // RF-P2: the serialized line is within the limit (serialize throws if not).
          const line = serialize({
            ...(prefix === undefined ? {} : { prefix }),
            command,
            params: [...leading, `${clamped}`],
          });
          expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(MAX_LINE_BYTES);

          // RF-P3: whole-code-point prefix of the input.
          expect(text.startsWith(clamped)).toBe(true);
          // No split surrogate pair: the result is well-formed (input is well-formed).
          expect(Buffer.from(clamped, "utf8").toString("utf8")).toBe(clamped);

          // Idempotent; text that already fits is unchanged.
          expect(clampTrailing(prefix, command, leading, clamped)).toBe(clamped);
          const head = [prefix === undefined ? undefined : `:${prefix}`, command, ...leading]
            .filter((p): p is string => p !== undefined)
            .join(" ");
          if (Buffer.byteLength(head, "utf8") + 4 + Buffer.byteLength(text, "utf8") <= MAX_LINE_BYTES) {
            expect(clamped).toBe(text);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});


describe("RF-P7 resource limits", () => {
  // Validates: Requirements 6.1
  it("RF-P7 token bucket never allows more than burst at once nor burst + refill over time", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 5000 }),
        fc.array(fc.integer({ min: 0, max: 10_000 }), { maxLength: 200 }),
        (burst, refillMs, gaps) => {
          let clock = 0;
          const bucket = new TokenBucket(burst, refillMs, () => clock);
          let accepted = 0;
          let run = 0;
          for (const gap of gaps) {
            clock += gap;
            if (gap > 0) run = 0;
            if (bucket.tryTake()) {
              accepted += 1;
              run += 1;
              // No time elapsed since the run began: at most `burst` lines.
              if (run > burst + Math.floor(gap / refillMs)) return false;
            }
            if (accepted > burst + Math.floor(clock / refillMs)) return false;
          }
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });

  // Validates: Requirements 6.2
  it("RF-P7 ConnectionGate never exceeds maxConnections", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.array(fc.boolean(), { maxLength: 100 }),
        (max, ops) => {
          const gate = new ConnectionGate(max);
          let live = 0;
          for (const acquire of ops) {
            if (acquire) {
              const ok = gate.tryAcquire();
              if (ok !== live < max) return false;
              if (ok) live += 1;
            } else if (live > 0) {
              gate.release();
              live -= 1;
            }
            if (gate.count !== live || gate.count > max) return false;
          }
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });

  // Validates: Requirements 6.4
  it("RF-P7 queued bytes never exceed maxWriteBufferBytes", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 64, max: 2000 }),
        fc.array(
          fc.record({
            text: fc.string({ unit: "grapheme", maxLength: 80 }),
            drain: fc.integer({ min: 0, max: 300 }),
          }),
          { maxLength: 60 },
        ),
        (cap, steps) => {
          const server = createServer(loadConfig({}), { error: () => {} });
          let buffered = 0;
          let peak = 0;
          const wire: Wire = {
            write: (line) => {
              buffered += Buffer.byteLength(line, "utf8");
              peak = Math.max(peak, buffered);
            },
            end: () => {},
            destroy: () => {},
            bufferedBytes: () => buffered,
            isDestroyed: () => false,
          };
          const session = new ConnectionSession(server.ctx, server.router, "n1", "h", wire, {
            ...DEFAULT_LIMITS,
            maxWriteBufferBytes: cap,
          });
          for (const step of steps) {
            session.client.send({ command: "NOTICE", params: ["x", step.text] });
            buffered = Math.max(0, buffered - step.drain);
            if (peak > cap) return false;
          }
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });
});


describe("RF-P8 origin allow-list", () => {
  const origin = fc
    .tuple(
      fc.constantFrom("http", "https"),
      fc.domain(),
      fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }),
    )
    .map(([scheme, host, port]) => `${scheme}://${host}${port === undefined ? "" : `:${port}`}`);
  const mixCase = (s: string, flips: readonly boolean[]): string =>
    [...s].map((c, i) => (flips[i % flips.length] ? c.toUpperCase() : c.toLowerCase())).join("");

  it("RF-P8 accepts an Origin iff absent, listed case-insensitively, or the list holds *", () => {
    // **Validates: Requirements 7.1, 7.2, 7.3**
    fc.assert(
      fc.property(
        fc.option(origin, { nil: undefined }),
        fc.array(origin, { maxLength: 5 }),
        fc.boolean(),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
        fc.boolean(),
        (o, others, wildcard, flips, includeIt) => {
          const list = others.map((x) => x.toLowerCase());
          if (o !== undefined && includeIt) list.push(o.toLowerCase());
          if (wildcard) list.push("*");
          const requested = o === undefined ? undefined : mixCase(o, flips);
          const expected =
            requested === undefined || wildcard || list.includes(requested.toLowerCase());
          expect(isOriginAllowed(requested, list)).toBe(expected);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("RF-P4 safeEqual agrees with strict equality", () => {
  // **Validates: Requirements 3.2**
  it("RF-P4 safeEqual(a, b) is true iff a === b (arbitrary strings)", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), fc.string({ unit: "binary" }), (a, b) => {
        expect(safeEqual(a, b)).toBe(a === b);
      }),
    );
  });

  it("RF-P4 safeEqual(a, a) is true and a longer string with the same prefix is false", () => {
    fc.assert(
      fc.property(
        fc.string({ unit: "binary" }),
        fc.string({ unit: "binary", minLength: 1 }),
        (a, suffix) => {
          expect(safeEqual(a, a)).toBe(true);
          expect(safeEqual(a, a + suffix)).toBe(false);
        },
      ),
    );
  });
});


describe("RF-P1 virtual client keep-alive and close", () => {
  // **Validates: Requirements 1.1, 1.3, 1.4**
  it("RF-P1 no keep-alive timer is scheduled and each peer sees exactly one QUIT for any number of close() calls", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 4 }), (closes, peers) => {
        let scheduled = 0;
        const timers: TimerApi = {
          setTimeout() {
            scheduled += 1;
            return scheduled;
          },
          clearTimeout() {},
        };
        const channels = new ChannelRegistry();
        const connections = new ConnectionManager(channels.memberIdsLookup, { timers });
        const ctx: RouterContext = {
          connections,
          channels,
          serverName: "seance",
          logger: { error: () => {} },
          events: new EventBus(),
        };
        const router = createRouter();
        const make = (id: string, nick: string) => {
          const c = createVirtualClient(ctx, router, { id });
          const msgs: IrcMessage[] = [];
          c.onMessage((m) => msgs.push(m));
          c.dispatch({ command: "NICK", params: [nick] });
          c.dispatch({ command: "USER", params: [nick, "0", "*", nick] });
          c.dispatch({ command: "JOIN", params: ["#t"] });
          // touch() must not schedule a timer for a virtual client either.
          connections.touch(c);
          return { c, msgs };
        };
        const subject = make("subject", "ghost");
        const others = Array.from({ length: peers }, (_, i) => make(`p${i}`, `peer${i}`));

        for (let i = 0; i < closes; i++) subject.c.close("bye");

        expect(scheduled).toBe(0);
        expect(connections.getByNick("ghost")).toBeUndefined();
        for (const p of others) {
          const quits = p.msgs.filter((m) => m.command === "QUIT" && m.prefix?.startsWith("ghost!"));
          expect(quits).toHaveLength(1);
        }
      }),
      { numRuns: 100 },
    );
  });
});


describe("RF-P6 closing a network client is final", () => {
  it("RF-P6 after close() no input is routed and the wire is destroyed within the grace period unless it closed earlier", () => {
    // **Validates: Requirements 5.1, 5.2, 5.3**
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10_000 }),
        fc.array(fc.string({ unit: "grapheme", maxLength: 60 }), { maxLength: 10 }),
        fc.option(fc.integer({ min: 0, max: 12_000 }), { nil: undefined }),
        fc.integer({ min: 0, max: 3 }),
        (graceMs, inputs, closedAt, extraCloses) => {
          // Manual fake timers: deterministic, no wall-clock waits.
          let clock = 0;
          let seq = 0;
          const pending = new Map<number, { at: number; fn: () => void }>();
          const timers: TimerApi = {
            setTimeout: (fn, ms) => {
              seq += 1;
              pending.set(seq, { at: clock + ms, fn });
              return seq;
            },
            clearTimeout: (h) => {
              pending.delete(h as number);
            },
          };
          const advanceTo = (t: number): void => {
            for (;;) {
              const due = [...pending.entries()]
                .filter(([, v]) => v.at <= t)
                .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
              if (due === undefined) break;
              pending.delete(due[0]);
              clock = Math.max(clock, due[1].at);
              due[1].fn();
            }
            clock = t;
          };

          const server = createServer(loadConfig({}), { error: () => {} });
          const dispatch = vi.spyOn(server.router, "dispatch");
          let destroyedAt: number | undefined;
          let destroys = 0;
          const wire: Wire = {
            write: () => {},
            end: () => {},
            destroy: () => {
              destroys += 1;
              destroyedAt ??= clock;
            },
            bufferedBytes: () => 0,
            isDestroyed: () => false,
          };
          const session = new ConnectionSession(server.ctx, server.router, "n1", "h", wire, {
            ...DEFAULT_LIMITS,
            closeGraceMs: graceMs,
            registrationTimeoutMs: 1_000_000,
            timers,
            now: () => clock,
          });

          session.client.close("bye");
          for (let i = 0; i < extraCloses; i += 1) session.client.close("again");
          const routedBefore = dispatch.mock.calls.length;

          // Req 5.1: input after close is never routed.
          for (const text of inputs) session.receive(`${text}\r\nPING x\r\n`);
          expect(dispatch.mock.calls.length).toBe(routedBefore);

          // Peer closes its side at `closedAt` (if at all).
          const earlyClose = closedAt !== undefined && closedAt < graceMs;
          if (closedAt !== undefined) {
            advanceTo(Math.min(closedAt, graceMs - 1));
            if (earlyClose) session.closed();
          }
          advanceTo(graceMs + 1);

          if (earlyClose) {
            // Req 5.3: closing earlier cancels the destroy timer.
            expect(destroys).toBe(0);
          } else {
            // Req 5.2: destroyed no later than the grace period, exactly once.
            expect(destroys).toBe(1);
            expect(destroyedAt).toBeLessThanOrEqual(graceMs);
          }
          expect(dispatch.mock.calls.length).toBe(routedBefore);
          dispatch.mockRestore();
        },
      ),
      { numRuns: 300 },
    );
  });
});
