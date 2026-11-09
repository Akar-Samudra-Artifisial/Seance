// public-hardening Requirements 1, 2 and 7 (ircd side): accounts, Auth_Mode registration,
// reserved nicks, PASS strikes, the client address behind a proxy and the per-address limits.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { IrcMessage } from "@seance/irc-protocol";
import { AccountsFileError, hashSecret, loadAccounts, parseAccounts } from "../src/accounts.js";
import type { Accounts } from "../src/accounts.js";
import { ChannelRegistry } from "../src/channel-registry.js";
import type { Client } from "../src/client.js";
import { canonicalIp, clientIp, isLoopbackIp, parseTrustedProxies } from "../src/client-ip.js";
import { trustedProxiesOk } from "../src/public-guard.js";
import { CommandRouter } from "../src/command-router.js";
import type { RouterContext } from "../src/command-router.js";
import { loadConfig } from "../src/config.js";
import { ConnectionManager } from "../src/connection-manager.js";
import { registerJoinHandler } from "../src/handlers/join.js";
import { MAX_HELD_LINES, MAX_PASS_STRIKES, registerRegistrationHandlers } from "../src/handlers/registration.js";
import { DEFAULT_LIMITS, PassFailures, PerIpGate } from "../src/limits.js";

/** Cheap scrypt parameters keep the tests fast; production uses DEFAULT_SCRYPT. */
const FAST = { N: 1024, r: 8, p: 1 } as const;
const ALICE_SECRET = "alice-secret-123";
const accounts: Accounts = parseAccounts(`# test accounts\nAlice:${hashSecret(ALICE_SECRET, FAST)}\n`);
const SERVER_PASSWORD = "guest-password";

const dir = mkdtempSync(join(tmpdir(), "seance-hardening-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

type Options = { readonly password?: string; readonly accounts?: Accounts; readonly agents?: readonly string[] };

function setup(opts: Options = {}) {
  const channels = new ChannelRegistry();
  const passFailures = new PassFailures(100);
  const ctx: RouterContext = {
    connections: new ConnectionManager(channels.memberIdsLookup),
    channels,
    serverName: "irc.test",
    ...(opts.password !== undefined ? { serverPassword: opts.password } : {}),
    ...(opts.accounts !== undefined ? { accounts: opts.accounts } : {}),
    reservedNicks: () => opts.agents ?? ["coder", "reviewer"],
    passFailures,
    logger: { error: vi.fn() },
  };
  const router = new CommandRouter();
  registerRegistrationHandlers(router);
  registerJoinHandler(router);
  let n = 0;
  const connect = (extra: Partial<Client> = {}) => {
    const sent: IrcMessage[] = [];
    const close = vi.fn();
    const client: Client = {
      id: `c${(n += 1)}`,
      registered: false,
      host: "198.51.100.7",
      send: (m) => {
        sent.push(m);
      },
      close,
      ...extra,
    };
    ctx.connections.add(client);
    const run = (command: string, ...params: string[]) => router.dispatch(ctx, client, { command, params });
    const register = (nick: string) => {
      run("NICK", nick);
      run("USER", "u", "0", "*", "User");
    };
    return { client, sent, close, run, register };
  };
  return { ctx, connect, passFailures };
}

const codes = (sent: readonly IrcMessage[]) => sent.map((m) => m.command);

describe("accounts file (Requirement 2.1)", () => {
  it("parses nick:hash lines, comments and blank lines; nicks use rfc1459 case-mapping", async () => {
    const a = parseAccounts(`\n# c\nAlice:${hashSecret("s3cret-value!", FAST)}\n\nbob[x]:${hashSecret("other-value!", FAST)}\n`);
    expect(a.size).toBe(2);
    expect(a.has("alice")).toBe(true);
    expect(a.has("BOB{X}")).toBe(true);
    expect(a.nameOf("ALICE")).toBe("Alice");
    expect(await a.verify("alice", "s3cret-value!")).toBe(true);
    expect(await a.verify("alice", "wrong")).toBe(false);
    expect(await a.verify("nobody", "s3cret-value!")).toBe(false);
  });

  it.each([
    ["no colon", "alice"],
    ["a bad nick", `1bad:${hashSecret("x".repeat(12), FAST)}`],
    ["a bad hash", "alice:sha1$abc"],
    ["N not a power of two", "alice:scrypt$1000$8$1$AAAAAAAAAAA=$AAAAAAAAAAAAAAAAAAAAAA=="],
    ["a duplicate", `a:${hashSecret("x".repeat(12), FAST)}\nA:${hashSecret("y".repeat(12), FAST)}`],
  ])("rejects %s, naming the line but not its content", (_label, text) => {
    expect(() => parseAccounts(text)).toThrow(AccountsFileError);
    try {
      parseAccounts(text);
    } catch (err) {
      expect((err as Error).message).toMatch(/IRCD_ACCOUNTS_FILE/);
      expect((err as Error).message).not.toContain("scrypt$1000");
    }
  });

  it("refuses a file readable by group or others, and loads a 0600 file", () => {
    const path = join(dir, "accounts");
    writeFileSync(path, `alice:${hashSecret(ALICE_SECRET, FAST)}\n`);
    chmodSync(path, 0o644);
    expect(() => loadAccounts(path)).toThrow(/chmod 600/);
    chmodSync(path, 0o640);
    expect(() => loadAccounts(path)).toThrow(AccountsFileError);
    chmodSync(path, 0o600);
    expect(loadAccounts(path).size).toBe(1);
    expect(() => loadAccounts(join(dir, "missing"))).toThrow(/cannot read/);
  });

  it("IRCD_ACCOUNTS_FILE is loaded by loadConfig; the new limits have defaults", () => {
    const path = join(dir, "accounts-config");
    writeFileSync(path, `alice:${hashSecret(ALICE_SECRET, FAST)}\n`);
    chmodSync(path, 0o600);
    const config = loadConfig({ IRCD_ACCOUNTS_FILE: path, IRCD_TRUSTED_PROXIES: "127.0.0.1, ::1" });
    expect(config.accounts?.has("alice")).toBe(true);
    expect([...config.trustedProxies].sort()).toEqual(["127.0.0.1", "::1"]);
    expect(config.maxConnectionsPerIp).toBe(5);
    expect(config.registrationTimeoutMs).toBe(15_000);
    expect(DEFAULT_LIMITS.registrationTimeoutMs).toBe(15_000);
    expect(() => loadConfig({ IRCD_TRUSTED_PROXIES: "caddy" })).toThrow(/IRCD_TRUSTED_PROXIES/);
  });
});

describe("Auth_Mode registration (Requirement 1)", () => {
  it("does not claim a nick before PASS succeeds (no squatting)", () => {
    const { ctx, connect } = setup({ password: SERVER_PASSWORD });
    const squatter = connect();
    squatter.run("NICK", "yhoyoex");
    expect(ctx.connections.getByNick("yhoyoex")).toBeUndefined();
    const owner = connect();
    owner.run("PASS", SERVER_PASSWORD);
    owner.register("yhoyoex");
    expect(owner.client.registered).toBe(true);
    expect(codes(owner.sent)).toContain("001");
    // The squatter never authenticated: USER now ends its attempt with 464.
    squatter.run("USER", "u", "0", "*", "U");
    expect(codes(squatter.sent)).toEqual(["464"]);
    expect(squatter.close).toHaveBeenCalled();
  });

  it("a guest gets 433 for an account nick and 432 for an agent nick, then may pick another", () => {
    const { connect } = setup({ password: SERVER_PASSWORD, accounts });
    const g = connect();
    g.run("PASS", SERVER_PASSWORD);
    g.register("ALICE");
    expect(codes(g.sent)).toEqual(["433"]);
    g.run("NICK", "Coder");
    expect(codes(g.sent)).toEqual(["433", "432"]);
    g.run("NICK", "guest1");
    expect(g.client.registered).toBe(true);
    expect(g.client.account).toBeUndefined();
    // Registered guests cannot rename into reserved nicks either.
    g.run("NICK", "alice");
    g.run("NICK", "reviewer");
    expect(codes(g.sent).slice(-2)).toEqual(["433", "432"]);
    expect(g.client.nick).toBe("guest1");
  });

  it("PASS <nick>:<secret> logs in the account, which must use its own nick and keeps it", async () => {
    const { connect } = setup({ accounts });
    const a = connect();
    a.run("PASS", `alice:${ALICE_SECRET}`);
    a.register("someoneelse");
    await vi.waitFor(() => {
      expect(codes(a.sent)).toEqual(["432"]);
    });
    a.run("NICK", "alice");
    expect(a.client.registered).toBe(true);
    expect(a.client.account).toBe("Alice");
    a.run("NICK", "alice2");
    expect(codes(a.sent).at(-1)).toBe("432");
    expect(a.client.nick).toBe("alice");
  });

  it("pipelined PASS/NICK/USER registers once the asynchronous verification succeeds", async () => {
    const { connect } = setup({ password: SERVER_PASSWORD, accounts });
    const a = connect();
    a.run("PASS", `Alice:${ALICE_SECRET}`);
    a.register("alice");
    expect(a.client.registered).toBe(false);
    await vi.waitFor(() => {
      expect(a.client.registered).toBe(true);
    });
    expect(a.client.account).toBe("Alice");
  });

  it(`closes after ${MAX_PASS_STRIKES} wrong PASS values and counts them per address`, () => {
    const { connect, passFailures } = setup({ password: SERVER_PASSWORD });
    const c = connect();
    c.run("PASS", "nope1");
    c.run("PASS", "nope2");
    expect(c.close).not.toHaveBeenCalled();
    expect(c.sent).toHaveLength(0);
    c.run("PASS", "nope3");
    expect(codes(c.sent)).toEqual(["464"]);
    expect(c.close).toHaveBeenCalledTimes(1);
    expect(passFailures.blocked("198.51.100.7")).toBe(false);
    for (let i = 0; i < 97; i += 1) passFailures.record("198.51.100.7");
    expect(passFailures.blocked("198.51.100.7")).toBe(true);
  });

  it("a wrong account secret is a strike; a wrong value and then the right one still logs in", async () => {
    let settled = 0;
    const counting: Accounts = {
      size: accounts.size,
      has: (n) => accounts.has(n),
      nameOf: (n) => accounts.nameOf(n),
      verify: (n, s) => accounts.verify(n, s).finally(() => {
        settled += 1;
      }),
    };
    const { connect } = setup({ accounts: counting });
    const c = connect();
    c.run("PASS", "alice:wrong-secret");
    await vi.waitFor(() => {
      expect(settled).toBe(1);
    });
    expect(c.close).not.toHaveBeenCalled();
    c.run("PASS", `alice:${ALICE_SECRET}`);
    c.register("alice");
    await vi.waitFor(() => {
      expect(c.client.registered).toBe(true);
    });
  });

  describe("PASS forms of the web client (a plain value gets the nick prefixed)", () => {
    const BOB_ACCOUNTS: Accounts = parseAccounts(
      `Alice:${hashSecret(ALICE_SECRET, FAST)}\nBob:${hashSecret(SERVER_PASSWORD, FAST)}\n`,
    );

    it("a plain server password is a guest", () => {
      for (const withAccounts of [false, true]) {
        const { connect } = setup({ password: SERVER_PASSWORD, ...(withAccounts ? { accounts } : {}) });
        const g = connect();
        g.run("PASS", SERVER_PASSWORD);
        g.register("guest1");
        expect(g.client.registered).toBe(true);
        expect(g.client.account).toBeUndefined();
      }
    });

    it("<nick>:<server password> is a guest too, with and without accounts configured", async () => {
      for (const withAccounts of [false, true]) {
        const { connect } = setup({ password: SERVER_PASSWORD, ...(withAccounts ? { accounts } : {}) });
        const g = connect();
        g.run("PASS", `guest1:${SERVER_PASSWORD}`);
        g.register("guest1");
        await vi.waitFor(() => {
          expect(g.client.registered).toBe(true);
        });
        expect(g.client.account).toBeUndefined();
        expect(g.close).not.toHaveBeenCalled();
      }
    });

    it("a valid account still logs in as the account", async () => {
      const { connect } = setup({ password: SERVER_PASSWORD, accounts });
      const a = connect();
      a.run("PASS", `alice:${ALICE_SECRET}`);
      a.register("alice");
      await vi.waitFor(() => {
        expect(a.client.registered).toBe(true);
      });
      expect(a.client.account).toBe("Alice");
    });

    it("an account whose secret equals the server password logs in as the account", async () => {
      const { connect } = setup({ password: SERVER_PASSWORD, accounts: BOB_ACCOUNTS });
      const b = connect();
      b.run("PASS", `bob:${SERVER_PASSWORD}`);
      b.register("bob");
      await vi.waitFor(() => {
        expect(b.client.registered).toBe(true);
      });
      expect(b.client.account).toBe("Bob");
      // The same value for a nick that is not an account is a guest, which may not take an account nick.
      const g = connect();
      g.run("PASS", `carol:${SERVER_PASSWORD}`);
      g.register("bob");
      await vi.waitFor(() => {
        expect(codes(g.sent)).toContain("433");
      });
      expect(g.client.account).toBeUndefined();
    });

    it("a wrong value is a strike and three close the connection, with accounts or without", async () => {
      for (const withAccounts of [false, true]) {
        let settled = 0;
        const counting: Accounts = {
          size: accounts.size,
          has: (n) => accounts.has(n),
          nameOf: (n) => accounts.nameOf(n),
          verify: (n, s) => accounts.verify(n, s).finally(() => {
            settled += 1;
          }),
        };
        const { connect } = setup({ password: SERVER_PASSWORD, ...(withAccounts ? { accounts: counting } : {}) });
        const c = connect();
        for (const wrong of ["alice:wrong-1", "guest1:wrong-2"]) {
          c.run("PASS", wrong);
          if (withAccounts) {
            const target = settled + 1;
            await vi.waitFor(() => {
              expect(settled).toBe(target);
            });
          }
          expect(c.close).not.toHaveBeenCalled();
          expect(c.client.registered).toBe(false);
        }
        c.run("PASS", "alice:wrong-3");
        await vi.waitFor(() => {
          expect(c.close).toHaveBeenCalledTimes(1);
        });
        expect(codes(c.sent)).toEqual(["464"]);
      }
    });
  });

  it("trusted in-process clients (agents) skip PASS and may use agent nicks", () => {
    const { connect } = setup({ password: SERVER_PASSWORD, accounts });
    const agent = connect({ virtual: true, trusted: true });
    agent.register("coder");
    expect(agent.client.registered).toBe(true);
    // An untrusted virtual client is treated like any other connection.
    const other = connect({ virtual: true });
    other.register("reviewer");
    expect(codes(other.sent)).toEqual(["464"]);
  });

  it("outside Auth_Mode nothing changes: NICK claims at once and agent nicks are free", () => {
    const { ctx, connect } = setup();
    const c = connect();
    c.run("NICK", "coder");
    expect(ctx.connections.getByNick("coder")).toBe(c.client);
  });
});

describe("commands during an account login (Requirement 13)", () => {
  it("pipelined PASS/NICK/USER/JOIN joins the channel once the login is verified", async () => {
    const { ctx, connect } = setup({ accounts });
    const a = connect();
    a.run("PASS", `alice:${ALICE_SECRET}`);
    a.register("alice");
    a.run("JOIN", "#haunt");
    expect(codes(a.sent)).not.toContain("451");
    await vi.waitFor(() => {
      expect(ctx.channels.get("#haunt")?.members.has(a.client.id)).toBe(true);
    });
    // The burst comes first, then the JOIN reply.
    const sent = codes(a.sent);
    expect(sent.indexOf("001")).toBeLessThan(sent.indexOf("JOIN"));
    expect(sent).not.toContain("451");
  });

  it(`holds at most ${MAX_HELD_LINES} lines; the rest get 451`, async () => {
    const { ctx, connect } = setup({ accounts });
    const a = connect();
    a.run("PASS", `alice:${ALICE_SECRET}`);
    a.register("alice");
    for (let i = 0; i < MAX_HELD_LINES + 3; i += 1) a.run("JOIN", `#c${i}`);
    expect(codes(a.sent).filter((c) => c === "451")).toHaveLength(3);
    await vi.waitFor(() => {
      expect(ctx.channels.get(`#c${MAX_HELD_LINES - 1}`)?.members.has(a.client.id)).toBe(true);
    });
    expect(ctx.channels.get(`#c${MAX_HELD_LINES}`)).toBeUndefined();
  });

  it("a failed login answers each held line with 451", async () => {
    let settled = 0;
    const counting: Accounts = {
      size: accounts.size,
      has: (n) => accounts.has(n),
      nameOf: (n) => accounts.nameOf(n),
      verify: (n, s) =>
        accounts.verify(n, s).finally(() => {
          settled += 1;
        }),
    };
    const { ctx, connect } = setup({ accounts: counting });
    const a = connect();
    a.run("PASS", "alice:wrong-secret");
    a.run("JOIN", "#haunt");
    a.run("JOIN", "#other");
    expect(a.sent).toHaveLength(0);
    await vi.waitFor(() => {
      expect(settled).toBe(1);
      expect(codes(a.sent)).toEqual(["451", "451"]);
    });
    expect(ctx.channels.get("#haunt")).toBeUndefined();
  });

  it("without a login in flight the old 451 stays", () => {
    const { connect } = setup({ password: SERVER_PASSWORD });
    const a = connect();
    a.run("JOIN", "#haunt");
    expect(codes(a.sent)).toEqual(["451"]);
  });
});

describe("client address behind a proxy (Requirement 7.1)", () => {
  const trusted = parseTrustedProxies("127.0.0.1,::1");

  it("uses X-Forwarded-For only from a trusted peer, right-most untrusted entry", () => {
    expect(clientIp("127.0.0.1", "203.0.113.9", trusted)).toBe("203.0.113.9");
    expect(clientIp("::ffff:127.0.0.1", "1.1.1.1, 203.0.113.9", trusted)).toBe("203.0.113.9");
    expect(clientIp("127.0.0.1", "203.0.113.9, 127.0.0.1", trusted)).toBe("203.0.113.9");
    expect(clientIp("198.51.100.1", "203.0.113.9", trusted)).toBe("198.51.100.1");
    expect(clientIp("127.0.0.1", "not-an-ip", trusted)).toBe("127.0.0.1");
    expect(clientIp("127.0.0.1", undefined, trusted)).toBe("127.0.0.1");
    expect(clientIp(undefined, "203.0.113.9", trusted)).toBeUndefined();
    expect(canonicalIp("::FFFF:10.0.0.1")).toBe("10.0.0.1");
  });
});

describe("one spelling per address (re-check 3)", () => {
  it.each([
    ["0:0:0:0:0:0:0:1", "::1"],
    ["::FFFF:127.0.0.1", "127.0.0.1"],
    ["::ffff:7f00:1", "127.0.0.1"],
    ["2001:DB8:0:0:0:0:0:1", "2001:db8::1"],
    [" 10.0.0.1 ", "10.0.0.1"],
    ["not-an-ip", "not-an-ip"],
  ])("canonicalIp(%j) is %j", (raw, expected) => {
    expect(canonicalIp(raw)).toBe(expected);
  });

  it("isLoopbackIp agrees for every spelling, and the guard uses the same rule", () => {
    for (const ip of ["127.0.0.1", "127.9.9.9", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
      expect(isLoopbackIp(ip)).toBe(true);
      expect(trustedProxiesOk(ip)).toBe(true);
    }
    for (const ip of ["10.0.0.1", "::2", "::ffff:10.0.0.1", "localhost", "128.0.0.1"]) {
      expect(isLoopbackIp(ip)).toBe(false);
      expect(trustedProxiesOk(ip)).toBe(false);
    }
  });

  it("a proxy written one way is trusted when the socket reports it another way", () => {
    // Long, short and IPv4-mapped spellings of the same proxy match each other in both directions.
    expect(clientIp("::1", "203.0.113.9", parseTrustedProxies("0:0:0:0:0:0:0:1"))).toBe("203.0.113.9");
    expect(clientIp("0:0:0:0:0:0:0:1", "203.0.113.9", parseTrustedProxies("::1"))).toBe("203.0.113.9");
    expect(clientIp("::ffff:127.0.0.1", "203.0.113.9", parseTrustedProxies("127.0.0.1"))).toBe("203.0.113.9");
    expect(clientIp("127.0.0.1", "203.0.113.9", parseTrustedProxies("::ffff:7f00:1"))).toBe("203.0.113.9");
    // A forged entry in another spelling of a trusted proxy is skipped, never taken as the client.
    expect(clientIp("127.0.0.1", "198.51.100.4, 0:0:0:0:0:0:0:1", parseTrustedProxies("127.0.0.1,::1"))).toBe("198.51.100.4");
  });
});

describe("per-address limits (Requirements 7.2, 7.3)", () => {
  it("PerIpGate caps live connections per address and frees them on release", () => {
    const gate = new PerIpGate(2);
    expect(gate.tryAcquire("a")).toBe(true);
    expect(gate.tryAcquire("a")).toBe(true);
    expect(gate.tryAcquire("a")).toBe(false);
    expect(gate.tryAcquire("b")).toBe(true);
    gate.release("a");
    expect(gate.tryAcquire("a")).toBe(true);
    expect(gate.tryAcquire(undefined)).toBe(true);
    expect(() => new PerIpGate(0)).toThrow(/maxConnectionsPerIp/);
  });

  it("PassFailures blocks an address at the limit until failures leave the window", () => {
    let now = 0;
    const f = new PassFailures(3, () => now, 1000);
    f.record("a");
    f.record("a");
    expect(f.blocked("a")).toBe(false);
    f.record("a");
    expect(f.blocked("a")).toBe(true);
    expect(f.blocked("b")).toBe(false);
    now = 1001;
    expect(f.blocked("a")).toBe(false);
  });
});
