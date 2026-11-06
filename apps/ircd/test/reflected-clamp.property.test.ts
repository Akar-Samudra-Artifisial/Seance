import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Numerics, serialize } from "@seance/irc-protocol";
import type { IrcMessage } from "@seance/irc-protocol";
import { ChannelRegistry } from "../src/channel-registry.js";
import type { Client } from "../src/client.js";
import type { RouterContext } from "../src/command-router.js";
import { ConnectionManager } from "../src/connection-manager.js";
import { reflectedReply } from "../src/replies.js";

const SERVER = "irc.test";

function makeCtx(): RouterContext {
  const channels = new ChannelRegistry();
  const connections = new ConnectionManager(channels.memberIdsLookup, {
    serverName: SERVER,
  });
  return {
    connections,
    channels,
    serverName: SERVER,
    logger: { error: () => {} },
  };
}

function makeClient(nick: string): Client & { readonly sent: IrcMessage[] } {
  const sent: IrcMessage[] = [];
  return {
    id: nick,
    nick,
    user: nick,
    host: "host",
    registered: true,
    sent,
    send: (m) => {
      sent.push(m);
    },
    close: () => {},
  };
}

interface Shape {
  readonly code: string;
  readonly values: number;
  readonly text: string;
}

const SHAPES: readonly Shape[] = [
  { code: Numerics.ERR_NOSUCHNICK, values: 1, text: "No such nick/channel" },
  { code: Numerics.ERR_NOSUCHCHANNEL, values: 1, text: "No such channel" },
  { code: Numerics.ERR_USERNOTINCHANNEL, values: 2, text: "They aren't on that channel" },
  { code: Numerics.ERR_NOTONCHANNEL, values: 1, text: "You're not on that channel" },
  { code: Numerics.ERR_USERONCHANNEL, values: 2, text: "is already on channel" },
  { code: Numerics.ERR_CHANOPRIVSNEEDED, values: 1, text: "You're not channel operator" },
];

// 1-, 2-, 3- and 4-byte characters, including a literal U+FFFD in the input.
const CHARS = ["a", "Z", "#", "é", "ñ", "€", "日", "\uFFFD", "👻", "🎃"] as const;

// Legal middle parameters (no space, no leading ':', non-empty), short or oversized.
const valueArb = fc
  .array(fc.constantFrom(...CHARS), { minLength: 1, maxLength: 600 })
  .map((cs) => cs.join(""))
  .filter((s) => !s.startsWith(":"));

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
const countFffd = (s: string): number => s.split("\uFFFD").length - 1;

describe("reflectedReply properties", () => {
  // Feature: ircd-agent-commands, Property 5: reflected clamp is identity when the reply fits, else a valid prefix within 512 bytes
  it("P5 reflected clamp identity and bound", () => {
    // **Validates: Requirements 9.1, 9.3**
    fc.assert(
      fc.property(
        fc.constantFrom(...SHAPES),
        fc.array(valueArb, { minLength: 2, maxLength: 2 }),
        (shape, pool) => {
          const inputs = pool.slice(0, shape.values);
          const ctx = makeCtx();
          const client = makeClient("me");
          reflectedReply(ctx, client, shape.code, inputs, shape.text);

          expect(client.sent).toHaveLength(1);
          const sent = client.sent[0] as IrcMessage;
          const unclamped: IrcMessage = {
            prefix: SERVER,
            command: shape.code,
            params: ["me", ...inputs, shape.text],
          };

          if (bytes(serialize(unclamped)) <= 512) {
            expect(sent).toEqual(unclamped);
            return;
          }

          expect(bytes(serialize(sent))).toBeLessThanOrEqual(512);
          inputs.forEach((input, i) => {
            const got = sent.params[1 + i] as string;
            expect(input.startsWith(got)).toBe(true);
            expect(countFffd(got)).toBeLessThanOrEqual(countFffd(input));
            expect(got).not.toContain("\uFFFD".repeat(countFffd(input) + 1));
          });
          expect(sent.params[sent.params.length - 1]).toBe(shape.text);
        },
      ),
      { numRuns: 200 },
    );
  });
});
