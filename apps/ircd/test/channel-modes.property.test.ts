// Feature: web-client-pixel-match, Property 5: Modes
// **Validates: Requirements 12.2, 12.3, 12.4, 12.5**
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { IrcMessage } from "@seance/irc-protocol";
import { ChannelRegistry } from "../src/channel-registry.js";
import type { Client } from "../src/client.js";
import { CommandRouter } from "../src/command-router.js";
import type { RouterContext } from "../src/command-router.js";
import { ConnectionManager } from "../src/connection-manager.js";
import { registerJoinHandler } from "../src/handlers/join.js";
import { registerModeHandler } from "../src/handlers/mode.js";
import { registerPrivmsgHandler } from "../src/handlers/privmsg.js";
import { registerTopicHandler } from "../src/handlers/topic.js";

type TestClient = Client & { readonly sent: IrcMessage[] };

function makeClient(id: string, nick: string): TestClient {
  const sent: IrcMessage[] = [];
  return { id, nick, user: nick, host: "host", registered: true, sent, send: (m) => void sent.push(m), close: () => {} };
}

type Change = { readonly c: "m" | "n" | "t" | "o" | "v"; readonly add: boolean };
type Step =
  | { readonly kind: "mode"; readonly by: "alice" | "bob"; readonly changes: readonly Change[] }
  | { readonly kind: "msg"; readonly by: "bob" | "eve" }
  | { readonly kind: "topic"; readonly by: "bob" | "eve" };

const changeArb = fc.record({ c: fc.constantFrom("m", "n", "t", "o", "v") as fc.Arbitrary<Change["c"]>, add: fc.boolean() });
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ kind: fc.constant("mode" as const), by: fc.constantFrom("alice" as const, "bob" as const), changes: fc.array(changeArb, { minLength: 1, maxLength: 4 }) }),
  fc.record({ kind: fc.constant("msg" as const), by: fc.constantFrom("bob" as const, "eve" as const) }),
  fc.record({ kind: fc.constant("topic" as const), by: fc.constantFrom("bob" as const, "eve" as const) }),
);

/** Reference model: flags, bob's membership flags, and the expected replies of one step. */
interface Model { m: boolean; n: boolean; t: boolean; bobOp: boolean; bobVoice: boolean }

/** Expected MODE params after the channel: sign runs over the effective changes, then args. */
function expectedModeParams(model: Model, changes: readonly Change[]): string[] {
  let modes = "";
  let sign = "";
  const args: string[] = [];
  for (const ch of changes) {
    const key = ch.c === "o" ? "bobOp" : ch.c === "v" ? "bobVoice" : ch.c;
    if (model[key] === ch.add) continue;
    model[key] = ch.add;
    const s = ch.add ? "+" : "-";
    if (s !== sign) {
      modes += s;
      sign = s;
    }
    modes += ch.c;
    if (ch.c === "o" || ch.c === "v") args.push("bob");
  }
  return modes === "" ? [] : [modes, ...args];
}

function world() {
  const channels = new ChannelRegistry();
  const connections = new ConnectionManager(channels.memberIdsLookup, { serverName: "irc.test" });
  const router = new CommandRouter();
  registerJoinHandler(router);
  registerModeHandler(router);
  registerPrivmsgHandler(router);
  registerTopicHandler(router);
  const ctx: RouterContext = { connections, channels, serverName: "irc.test", logger: { error: () => {} } };
  const alice = makeClient("1", "alice");
  const bob = makeClient("2", "bob");
  const eve = makeClient("3", "eve");
  for (const c of [alice, bob, eve]) connections.add(c);
  const run = (c: Client, command: string, ...params: string[]) => router.dispatch(ctx, c, { command, params });
  run(alice, "JOIN", "#t");
  run(bob, "JOIN", "#t");
  return { alice, bob, eve, run, channels };
}

describe("P5 channel modes match model", () => {
  it("P5 MODE, PRIVMSG and TOPIC replies and delivery equal the reference model", () => {
    fc.assert(
      fc.property(fc.array(stepArb, { minLength: 1, maxLength: 25 }), (steps) => {
        const w = world();
        const model: Model = { m: false, n: true, t: true, bobOp: false, bobVoice: false };
        const clients = { alice: w.alice, bob: w.bob, eve: w.eve };
        for (const step of steps) {
          for (const c of Object.values(clients)) c.sent.length = 0;
          const sender = clients[step.by];
          if (step.kind === "mode") {
            const modeString = step.changes.map((ch) => `${ch.add ? "+" : "-"}${ch.c}`).join("");
            const args = step.changes.filter((ch) => ch.c === "o" || ch.c === "v").map(() => "bob");
            w.run(sender, "MODE", "#t", modeString, ...args);
            const isOp = step.by === "alice" || model.bobOp;
            if (!isOp) {
              expect(sender.sent.map((m) => m.command)).toEqual(["482"]);
              // A refused MODE is never broadcast (alice is always op, so the sender is not alice here).
              expect(w.alice.sent).toEqual([]);
            } else {
              const params = expectedModeParams(model, step.changes);
              const expected = params.length === 0 ? [] : [{ prefix: `${step.by}!${step.by}@host`, command: "MODE", params: ["#t", ...params] }];
              expect(w.alice.sent).toEqual(expected);
              expect(w.bob.sent).toEqual(expected);
            }
          } else if (step.kind === "msg") {
            w.run(sender, "PRIVMSG", "#t", "hello");
            const allowed =
              step.by === "bob" ? !model.m || model.bobOp || model.bobVoice : !model.n && !model.m;
            expect(w.alice.sent.some((m) => m.command === "PRIVMSG")).toBe(allowed);
            expect(sender.sent.map((m) => m.command)).toEqual(allowed ? [] : ["404"]);
          } else {
            w.run(sender, "TOPIC", "#t", "new topic");
            if (step.by === "eve") {
              expect(w.eve.sent.map((m) => m.command)).toEqual(["442"]);
            } else {
              const allowed = !model.t || model.bobOp;
              expect(w.bob.sent.map((m) => m.command)).toEqual(allowed ? ["TOPIC"] : ["482"]);
              expect(w.alice.sent.map((m) => m.command)).toEqual(allowed ? ["TOPIC"] : []);
            }
          }
          const modes = w.channels.get("#t")?.modes;
          expect(modes).toEqual({ moderated: model.m, noExternal: model.n, topicLock: model.t });
        }
      }),
      { numRuns: 200 },
    );
  });
});
