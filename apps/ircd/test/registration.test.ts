import { describe, expect, it, vi } from "vitest";
import type { IrcMessage } from "@seance/irc-protocol";
import { ChannelRegistry } from "../src/channel-registry.js";
import type { Client } from "../src/client.js";
import { CommandRouter } from "../src/command-router.js";
import type { RouterContext } from "../src/command-router.js";
import { ConnectionManager } from "../src/connection-manager.js";
import { DEFAULT_MOTD, registerRegistrationHandlers } from "../src/handlers/registration.js";

function setup(serverPassword?: string) {
  const channels = new ChannelRegistry();
  const ctx: RouterContext = {
    connections: new ConnectionManager(channels.memberIdsLookup),
    channels,
    serverName: "irc.test",
    ...(serverPassword !== undefined ? { serverPassword } : {}),
    logger: { error: vi.fn() },
  };
  const router = new CommandRouter();
  registerRegistrationHandlers(router);

  let n = 0;
  const connect = () => {
    const sent: IrcMessage[] = [];
    const close = vi.fn();
    const client: Client = {
      id: `c${(n += 1)}`,
      registered: false,
      send: (m) => {
        sent.push(m);
      },
      close,
    };
    ctx.connections.add(client);
    const run = (command: string, ...params: string[]) =>
      router.dispatch(ctx, client, { command, params });
    return { client, sent, close, run };
  };
  return { ctx, connect };
}

const codes = (sent: readonly IrcMessage[]) => sent.map((m) => m.command);

describe("welcome burst and MOTD (Req 3.9)", () => {
  const BURST = ["001", "002", "003", "004", "005", "375", ...DEFAULT_MOTD.map(() => "372"), "376"];

  it("sends 001-005 then 375/372/376 in order, to the registered nick", () => {
    const a = setup().connect();
    a.run("NICK", "alice");
    expect(a.sent).toHaveLength(0);
    a.run("USER", "alice", "0", "*", "Alice");
    expect(codes(a.sent)).toEqual(BURST);
    expect(a.sent.every((m) => m.prefix === "irc.test" && m.params[0] === "alice")).toBe(true);
  });

  it("sends the burst once, even if USER or NICK is repeated", () => {
    const a = setup().connect();
    a.run("NICK", "alice");
    a.run("USER", "alice", "0", "*", "Alice");
    a.run("USER", "alice", "0", "*", "Alice");
    a.run("NICK", "alice2");
    expect(codes(a.sent).filter((c) => c === "001")).toHaveLength(1);
  });

  it("sends one 372 per configured MOTD line", () => {
    const { ctx, connect } = setup();
    const custom = { ...ctx, motd: ["one", "two"] } as RouterContext;
    const a = connect();
    const router = new CommandRouter();
    registerRegistrationHandlers(router);
    router.dispatch(custom, a.client, { command: "NICK", params: ["alice"] });
    router.dispatch(custom, a.client, { command: "USER", params: ["a", "0", "*", "A"] });
    expect(codes(a.sent).filter((c) => c === "372")).toHaveLength(2);
  });

  it("sends the haunted default MOTD from frame 02, one 372 per line", () => {
    const a = setup().connect();
    a.run("NICK", "alice");
    a.run("USER", "alice", "0", "*", "Alice");
    const motd = a.sent.filter((m) => m.command === "372").map((m) => m.params[1]);
    expect(motd).toEqual(DEFAULT_MOTD.map((line) => `- ${line}`));
    expect(motd).toContain("- This server is haunted.");
    expect(motd).toContain("- /invite <agent> to summon · /kick <agent> to exorcise");
    expect(motd).toContain("-   /   /_\\ /_\\   \\");
  });

  it("keeps every default MOTD line short and free of control characters", () => {
    for (const line of DEFAULT_MOTD) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(400);
      expect(line).not.toMatch(/[\r\n\0]/);
    }
  });

  it("sends no burst when the password is wrong", () => {
    const a = setup("s3cret").connect();
    a.run("PASS", "nope");
    a.run("NICK", "alice");
    a.run("USER", "alice", "0", "*", "Alice");
    expect(codes(a.sent)).toEqual(["464"]);
  });

  it("sends the burst with the correct password", () => {
    const a = setup("s3cret").connect();
    a.run("PASS", "s3cret");
    a.run("NICK", "alice");
    a.run("USER", "alice", "0", "*", "Alice");
    expect(codes(a.sent)).toEqual(BURST);
  });
});

describe("nick change broadcast (Req 3.10)", () => {
  function registered(env: ReturnType<typeof setup>, nick: string) {
    const c = env.connect();
    c.run("NICK", nick);
    c.run("USER", nick, "0", "*", nick);
    c.sent.length = 0;
    return c;
  }

  it("sends the change to self and once to each peer sharing channels", () => {
    const env = setup();
    const a = registered(env, "alice");
    const b = registered(env, "bob");
    const c = registered(env, "carol");
    for (const x of [a, b]) {
      env.ctx.channels.join(x.client.id, "#one");
      env.ctx.channels.join(x.client.id, "#two");
    }
    a.run("NICK", "alice2");
    const expected = { prefix: "alice!alice@irc.test", command: "NICK", params: ["alice2"] };
    expect(a.sent).toEqual([expected]);
    expect(b.sent).toEqual([expected]);
    expect(c.sent).toEqual([]);
  });

  it("sends only to self without channels, updates index and releases old nick", () => {
    const env = setup();
    const a = registered(env, "alice");
    a.run("NICK", "Alice2");
    expect(a.sent).toHaveLength(1);
    expect(env.ctx.connections.getByNick("alice")).toBeUndefined();
    expect(env.ctx.connections.getByNick("alice2")).toBe(a.client);
    const b = registered(env, "bob");
    b.run("NICK", "alice");
    expect(b.client.nick).toBe("alice");
  });

  it("433 and no broadcast when the new nick is taken", () => {
    const env = setup();
    const a = registered(env, "alice");
    const b = registered(env, "bob");
    env.ctx.channels.join(a.client.id, "#x");
    env.ctx.channels.join(b.client.id, "#x");
    a.run("NICK", "BOB");
    expect(codes(a.sent)).toEqual(["433"]);
    expect(b.sent).toEqual([]);
    expect(a.client.nick).toBe("alice");
  });

  it("allows a case-only change and ignores an identical nick", () => {
    const env = setup();
    const a = registered(env, "alice");
    a.run("NICK", "alice");
    expect(a.sent).toEqual([]);
    a.run("NICK", "ALICE");
    expect(a.sent).toHaveLength(1);
    expect(a.client.nick).toBe("ALICE");
  });
});

describe("registration handlers", () => {
  it("registers after NICK and USER", () => {
    const { connect } = setup();
    const a = connect();
    a.run("NICK", "alice");
    expect(a.client.registered).toBe(false);
    a.run("USER", "alice", "0", "*", "Alice");
    expect(a.client.registered).toBe(true);
    expect(a.client.user).toBe("alice");
  });

  it("431 when NICK has no parameter", () => {
    const a = setup().connect();
    a.run("NICK");
    expect(codes(a.sent)).toEqual(["431"]);
  });

  it("432 for erroneous nicks", () => {
    const a = setup().connect();
    a.run("NICK", "1abc");
    a.run("NICK", "");
    a.run("NICK", "a".repeat(31));
    expect(codes(a.sent)).toEqual(["432", "432", "432"]);
    expect(a.client.nick).toBeUndefined();
  });

  it("433 when nick is in use, case-insensitively under rfc1459", () => {
    const { connect } = setup();
    const a = connect();
    const b = connect();
    a.run("NICK", "Al[ice]");
    b.run("NICK", "al{ice}");
    expect(codes(b.sent)).toEqual(["433"]);
    expect(b.client.nick).toBeUndefined();
  });

  it("461 for USER with too few params", () => {
    const a = setup().connect();
    a.run("USER", "alice", "0", "*");
    expect(codes(a.sent)).toEqual(["461"]);
  });

  it("462 for USER and PASS after registration, state unchanged", () => {
    const a = setup().connect();
    a.run("NICK", "alice");
    a.run("USER", "alice", "0", "*", "Alice");
    a.run("USER", "mallory", "0", "*", "Mallory");
    a.run("PASS", "x");
    expect(codes(a.sent).slice(7 + DEFAULT_MOTD.length)).toEqual(["462", "462"]);
    expect(a.client.user).toBe("alice");
    expect(a.client.registered).toBe(true);
  });

  it("registers with the correct password", () => {
    const a = setup("s3cret").connect();
    a.run("PASS", "s3cret");
    a.run("NICK", "alice");
    a.run("USER", "alice", "0", "*", "Alice");
    expect(a.client.registered).toBe(true);
    expect(a.close).not.toHaveBeenCalled();
  });

  it("464 and close when the password is missing", () => {
    const a = setup("s3cret").connect();
    a.run("NICK", "alice");
    a.run("USER", "alice", "0", "*", "Alice");
    expect(codes(a.sent)).toEqual(["464"]);
    expect(a.close).toHaveBeenCalledOnce();
    expect(a.client.registered).toBe(false);
  });

  it("464 and close when the password is wrong", () => {
    const a = setup("s3cret").connect();
    a.run("PASS", "nope");
    a.run("USER", "alice", "0", "*", "Alice");
    a.run("NICK", "alice");
    expect(codes(a.sent)).toEqual(["464"]);
    expect(a.close).toHaveBeenCalledOnce();
  });
});
