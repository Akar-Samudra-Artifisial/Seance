import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { DEFAULT_MOTD } from "../src/handlers/registration.js";
import { DEFAULT_LIMITS } from "../src/limits.js";
import { ConnectionSession } from "../src/network-client.js";
import type { Wire } from "../src/network-client.js";
import { createServer } from "../src/server.js";

// End-to-end through the real server, router and session (Req 3.1, 3.2, 3.5,
// 3.9, 3.10, 4.1-4.4). Timers are faked; no real sleeping.

const IDLE = 1000;
const TIMEOUT = 500;
const quiet = { error: () => {} };

function world(env: Record<string, string> = {}) {
  const server = createServer(
    loadConfig({
      IRCD_SERVER_NAME: "irc.test",
      IRCD_IDLE_INTERVAL_MS: String(IDLE),
      IRCD_PING_TIMEOUT_MS: String(TIMEOUT),
      ...env,
    }),
    quiet,
  );
  let n = 0;
  const connect = () => {
    const written: string[] = [];
    const wire: Wire = {
      write: (line) => {
        written.push(line);
      },
      end: () => {},
      destroy: () => {},
      bufferedBytes: () => 0,
      isDestroyed: () => false,
    };
    n += 1;
    const session = new ConnectionSession(
      server.ctx,
      server.router,
      `n${n}`,
      "203.0.113.9",
      wire,
      DEFAULT_LIMITS,
    );
    // Command or numeric of every line written so far, prefix stripped.
    const cmds = () =>
      written.map((l) => l.replace(/^:\S+ /, "").split(" ")[0] ?? "");
    return { session, written, cmds };
  };
  return { server, connect };
}

describe("registration over the wire", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("welcome burst 001-005 then 375/372/376", () => {
    const a = world().connect();
    a.session.receive("NICK alice\r\nUSER alice 0 * :Alice\r\n");
    expect(a.cmds()).toEqual([
      "001",
      "002",
      "003",
      "004",
      "005",
      "375",
      ...DEFAULT_MOTD.map(() => "372"),
      "376",
    ]);
  });

  it("431, 432 and 433 before registration", () => {
    const w = world();
    const a = w.connect();
    const b = w.connect();
    a.session.receive("NICK alice\r\n");
    b.session.receive("NICK\r\nNICK 1bad\r\nNICK ALICE\r\n");
    expect(b.cmds()).toEqual(["431", "432", "433"]);
  });

  it("464 on a wrong password, 462 on USER and PASS after registering", () => {
    const w = world({ IRCD_SERVER_PASSWORD: "s3cret" });
    const bad = w.connect();
    bad.session.receive("PASS nope\r\nNICK bad\r\nUSER bad 0 * :Bad\r\n");
    expect(bad.cmds()).toContain("464");
    expect(bad.cmds()).not.toContain("001");

    const ok = w.connect();
    ok.session.receive("PASS s3cret\r\nNICK ok\r\nUSER ok 0 * :Ok\r\n");
    ok.written.length = 0;
    ok.session.receive("PASS s3cret\r\nUSER ok 0 * :Ok\r\n");
    expect(ok.cmds()).toEqual(["462", "462"]);
  });

  it("NICK change reaches self and a channel peer once", () => {
    const w = world();
    const a = w.connect();
    const b = w.connect();
    a.session.receive("NICK alice\r\nUSER alice 0 * :A\r\nJOIN #x\r\n");
    b.session.receive("NICK bob\r\nUSER bob 0 * :B\r\nJOIN #x\r\n");
    a.written.length = 0;
    b.written.length = 0;
    a.session.receive("NICK alice2\r\n");
    expect(a.written).toHaveLength(1);
    expect(b.written).toHaveLength(1);
    expect(b.written[0]).toMatch(/^:alice!alice@\S+ NICK alice2\r\n$/);
  });
});

describe("keep-alive over the wire", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("PING gets PONG; PING without a token gets 461", () => {
    const a = world().connect();
    a.session.receive("NICK alice\r\nUSER alice 0 * :A\r\n");
    a.written.length = 0;
    a.session.receive("PING token\r\nPING\r\n");
    expect(a.written[0]).toBe(":irc.test PONG irc.test token\r\n");
    expect(a.cmds()[1]).toBe("461");
  });

  it("idle PING, then 'Ping timeout' close when unanswered", () => {
    const a = world().connect();
    a.session.receive("NICK alice\r\nUSER alice 0 * :A\r\n");
    a.written.length = 0;
    vi.advanceTimersByTime(IDLE);
    expect(a.written).toEqual(["PING irc.test\r\n"]);
    vi.advanceTimersByTime(TIMEOUT);
    expect(a.written.at(-1)).toBe("ERROR :Closing Link: Ping timeout\r\n");
  });

  it("a PONG after the idle PING keeps the connection open", () => {
    const a = world().connect();
    a.session.receive("NICK alice\r\nUSER alice 0 * :A\r\n");
    a.written.length = 0;
    vi.advanceTimersByTime(IDLE);
    a.session.receive("PONG irc.test\r\n");
    vi.advanceTimersByTime(TIMEOUT);
    expect(a.written).toEqual(["PING irc.test\r\n"]);
  });
});
