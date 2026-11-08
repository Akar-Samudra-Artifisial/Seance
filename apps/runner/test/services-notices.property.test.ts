// runner-services design Properties 1 to 3.
import { serialize } from "@seance/irc-protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { NOTICE_MAX_BYTES, agentsOnline, filesReverted, sessionEnded, worktreeReady } from "../src/services/notices.js";
import { agentStatus, renderWhois } from "../src/whois/render.js";
import type { AgentStatus } from "../src/whois/render.js";
import { WhoisSnapshot } from "../src/whois/snapshot.js";

const bytes = (s: string): number => new TextEncoder().encode(s).length;
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001F\u007F-\u009F]/;
const STATUSES: readonly AgentStatus[] = ["idle", "prompting", "cooldown", "away"];

const anyText = fc.string({ unit: "binary", maxLength: 600 });
const sha = fc.stringMatching(/^[0-9a-f]{7}$/);
const nick = fc.stringMatching(/^[A-Za-z][A-Za-z0-9_-]{0,15}$/);
/** Longest prefix and channel the ircd allows: 63-byte host, `#` plus 49 multi-byte characters. */
const PREFIX = `NickServ!NickServ@services.${"h".repeat(63)}`;
const CHANNEL = `#${"é".repeat(49)}`;

describe("P1 notice bounds", () => {
  it("P1 notice bounds: no controls, within NOTICE_MAX_BYTES, and the full NOTICE fits 512 bytes", () => {
    fc.assert(
      fc.property(
        anyText,
        sha,
        fc.boolean(),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.double({ min: 0, max: 1e9, noNaN: true }),
        fc.array(fc.record({ nick: fc.oneof(nick, anyText), status: fc.constantFrom(...STATUSES) }), { maxLength: 40 }),
        (dir, s, cancelled, files, credits, agents) => {
          const texts = [
            worktreeReady(dir, s),
            sessionEnded({ cancelled, sha: s }),
            filesReverted({ files, credits }),
            agentsOnline(agents),
          ].filter((t): t is string => t !== undefined);
          for (const t of texts) {
            expect(CONTROLS.test(t)).toBe(false);
            expect(bytes(t)).toBeLessThanOrEqual(NOTICE_MAX_BYTES);
            const line = serialize({ prefix: PREFIX, command: "NOTICE", params: [CHANNEL, t] });
            expect(bytes(line)).toBeLessThanOrEqual(512);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("P2 roster is exact", () => {
  it("P2 roster is exact: every nick once, Registry order inside groups, groups by first appearance", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(nick, { minLength: 1, maxLength: 12, selector: (n) => n.toLowerCase() }),
        fc.array(fc.constantFrom(...STATUSES), { minLength: 12, maxLength: 12 }),
        (nicks, statuses) => {
          const agents = nicks.map((n, i) => ({ nick: n, status: statuses[i] ?? "idle" }));
          const text = agentsOnline(agents);
          expect(text.startsWith("agents online: ")).toBe(true);
          const groups = text.slice("agents online: ".length).split("; ");
          const order: AgentStatus[] = [];
          for (const a of agents) if (!order.includes(a.status)) order.push(a.status);
          expect(groups).toHaveLength(order.length);
          groups.forEach((g, gi) => {
            const status = order[gi];
            expect(g.endsWith(` (${String(status)})`)).toBe(true);
            const listed = g.slice(0, g.length - ` (${String(status)})`.length).split(", ");
            expect(listed).toEqual(agents.filter((a) => a.status === status).map((a) => a.nick));
          });
        },
      ),
      { numRuns: 200 },
    );
  });

  it("P2 roster is exact: statuses equal agentStatus of the snapshot (WHOIS agrees)", () => {
    fc.assert(
      fc.property(fc.constantFrom("idle", "prompting", "cooldown", "closed"), fc.option(fc.string(), { nil: undefined }), (state, away) => {
        const snapshot = new WhoisSnapshot();
        snapshot.register("coder", { model: "m", tools: "t" });
        snapshot.setState("coder", "#dev", state);
        snapshot.setAway("coder", away);
        const status = agentStatus(snapshot.get("coder"));
        expect(renderWhois(snapshot.get("coder"))).toContain(`status: ${status}`);
        expect(agentsOnline([{ nick: "coder", status }])).toBe(`agents online: coder (${status})`);
      }),
    );
  });
});

describe("P3 credits agree with whois", () => {
  it("P3 credits agree with whois: X.XX of the notice equals `used` of the 320 line", () => {
    fc.assert(
      fc.property(fc.double({ min: 0.005, max: 1e6, noNaN: true }), fc.integer({ min: 0, max: 50 }), (amount, files) => {
        const snapshot = new WhoisSnapshot();
        snapshot.register("coder", { model: "m", tools: "t" });
        snapshot.setState("coder", "#dev", "idle");
        snapshot.setCredits("coder", "#dev", amount);
        const line = renderWhois(snapshot.get("coder")).find((l) => l.startsWith("credits: #dev "));
        const used = line?.split(" ")[2];
        const notice = filesReverted({ files, credits: amount });
        expect(notice).toBeDefined();
        expect(notice?.split(" · ")[1]).toBe(`${String(used)} credits used`);
      }),
      { numRuns: 300 },
    );
  });
});
