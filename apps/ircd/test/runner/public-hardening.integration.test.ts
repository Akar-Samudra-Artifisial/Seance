// public-hardening against a real Fake_Agent process and the in-process ircd: inviters need an
// account (Requirement 3), the daily credit cap and the kill switch (5.2, 5.3), the WHOIS budget
// line (5.4) and reserved agent nicks (2.3).
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashSecret } from "../../src/accounts.js";
import { ManualClock, closeAllFixtures, startIntegration } from "./integration.js";
import type { FakeAgentScript, IntegrationFixture, IrcTestClient, LogRecord } from "./integration.js";

const CHANNEL = "#haunt";
const TEST_TIMEOUT_MS = 30_000;
const UNTIL_TIMEOUT_MS = 10_000;
const GUEST_PASSWORD = "guest-password-for-tests";
const ALICE_SECRET = "alice-secret-for-tests";

const clocks = new Set<ManualClock>();
const dirs: string[] = [];

afterEach(async () => {
  const pump = setInterval(() => {
    for (const c of clocks) c.advance(1_000);
  }, 10);
  try {
    await closeAllFixtures();
  } finally {
    clearInterval(pump);
    clocks.clear();
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  }
}, TEST_TIMEOUT_MS);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function until<T>(what: string, find: () => T | undefined, timeoutMs = UNTIL_TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = find();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

const logged = (f: IntegrationFixture, pred: (r: LogRecord) => boolean): LogRecord | undefined => f.logs.find(pred);

async function accountsFile(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "seance-accounts-")));
  dirs.push(dir);
  const path = join(dir, "accounts");
  await writeFile(path, `alice:${hashSecret(ALICE_SECRET, { N: 1024, r: 8, p: 1 })}\n`);
  await chmod(path, 0o600);
  return path;
}

async function start(script: FakeAgentScript, env: Readonly<Record<string, string>> = {}): Promise<IntegrationFixture> {
  const clock = new ManualClock();
  clocks.add(clock);
  return startIntegration({
    script,
    clock,
    // alice sends many commands in a row; the default burst of 10 would close her for flooding.
    floodBurst: 100,
    env: { SEANCE_INVITERS: "alice", ...env },
    ircdEnv: { IRCD_SERVER_PASSWORD: GUEST_PASSWORD, IRCD_ACCOUNTS_FILE: await accountsFile() },
  });
}

/** alice (logged in as her account) invites coder and gives it +o. */
async function summon(f: IntegrationFixture): Promise<IrcTestClient> {
  const alice = await f.connectClient("alice", `alice:${ALICE_SECRET}`);
  await alice.join(CHANNEL);
  alice.send(`INVITE coder ${CHANNEL}`);
  await alice.waitFor(/^:\S+ 341 /);
  await until("coder session", () => logged(f, (r) => r.msg === "agent joined channel" && r.fields?.["channel"] === CHANNEL));
  alice.send(`MODE ${CHANNEL} +o coder`);
  await alice.waitFor(new RegExp(`^:alice!\\S+ MODE ${escapeRegExp(CHANNEL)} \\+o coder`, "i"));
  return alice;
}

/** The `320` lines of one fresh WHOIS (earlier replies are skipped). */
async function whoisLines(c: IrcTestClient, nick: string): Promise<readonly string[]> {
  const from = c.lines.length;
  c.send(`WHOIS ${nick}`);
  await c.waitFor(new RegExp(`^:\\S+ 318 \\S+ ${escapeRegExp(nick)} `));
  const prefix = new RegExp(`^:\\S+ 320 \\S+ ${escapeRegExp(nick)} :?(.*)$`);
  return c.lines.slice(from).flatMap((l) => {
    const m = prefix.exec(l);
    return m?.[1] !== undefined ? [m[1]] : [];
  });
}

const metered = (word: string, credits: number) => ({
  match: word,
  steps: [{ chunk: word }, { metadata: { credits: [{ value: credits, unit: "credit" }] } }],
});

describe("public-hardening with accounts (Fake_Agent + in-process ircd)", { timeout: TEST_TIMEOUT_MS }, () => {
  it("SEANCE_INVITERS may name accounts only: a guest nick there stops the start", async () => {
    const clock = new ManualClock();
    clocks.add(clock);
    const f = await startIntegration({
      script: { turns: [] },
      clock,
      autoStart: false,
      env: { SEANCE_INVITERS: "alice,bob" },
      ircdEnv: { IRCD_SERVER_PASSWORD: GUEST_PASSWORD, IRCD_ACCOUNTS_FILE: await accountsFile() },
    });
    await expect(f.runner.start()).rejects.toThrow(/SEANCE_INVITERS.*bob/);
  });

  it("a guest cannot invite or take an account or agent nick; the logged-in account can invite", async () => {
    const f = await start({ turns: [] });
    // `bob` is a guest (server password). A guest's INVITE never starts an agent, and a guest
    // cannot take alice's nick to pass the SEANCE_INVITERS check.
    const bob = await f.connectClient("bob", GUEST_PASSWORD);
    await bob.join("#lobby"); // bob is op there; ops may invite, but a guest is not an Inviter
    bob.send("INVITE coder #lobby");
    await bob.waitFor(/^:\S+ 401 bob coder /);
    expect(await bob.expectNone(/^:\S+ 341 /, 500)).toBe(true);
    expect(logged(f, (r) => r.msg === "agent joined channel")).toBeUndefined();
    // Agent nicks are reserved for the runner's agents.
    bob.send("NICK reviewer");
    await bob.waitFor(/^:\S+ 432 bob reviewer /);
    bob.send("NICK alice");
    await bob.waitFor(/^:\S+ 433 bob alice /);

    await summon(f);
    expect(logged(f, (r) => r.msg === "agent joined channel")).toBeDefined();
  });

  it("the daily cap stops new turns with a ChanServ notice and WHOIS shows the budget", async () => {
    const f = await start({ turns: [metered("spend", 1.5), metered("more", 0.1)] }, { SEANCE_DAILY_CREDIT_CAP: "1" });
    const alice = await summon(f);
    expect(await whoisLines(alice, "coder")).toContain("budget: today 0.00 / 1.00 (UTC)");

    alice.send(`PRIVMSG ${CHANNEL} :spend`);
    await alice.waitFor(new RegExp(`^:ChanServ!\\S+ NOTICE ${escapeRegExp(CHANNEL)} :?daily credit budget reached$`), 15_000);
    alice.send(`PRIVMSG ${CHANNEL} :more`);
    await until("prompt refused", () =>
      logged(f, (r) => r.msg === "prompt dropped" && r.fields?.["channel"] === CHANNEL && r.fields?.["why"] === "credit-blocked"),
    );
    const lines = await whoisLines(alice, "coder");
    const status = lines.findIndex((l) => l.startsWith("status:"));
    expect(lines[status + 1]).toBe("budget: today 1.50 / 1.00 (UTC), reached");
    // A new invite is refused while the cap holds.
    await alice.join("#other");
    alice.send("INVITE coder #other");
    await alice.waitFor(/NOTICE alice :.*daily credit budget reached/);
  });

  it("the kill switch file pauses new turns without a restart", async () => {
    const f = await start({ turns: [metered("one", 0.1), metered("two", 0.1)] });
    const alice = await summon(f);
    alice.send(`PRIVMSG ${CHANNEL} :one`);
    await alice.waitFor(/^:coder!\S+ PRIVMSG /, 15_000);
    await writeFile(join(f.workspaces, ".seance-paused"), "");
    alice.send(`PRIVMSG ${CHANNEL} :two`);
    await until("prompt refused", () =>
      logged(f, (r) => r.msg === "prompt dropped" && r.fields?.["channel"] === CHANNEL && r.fields?.["why"] === "credit-blocked"),
    );
    expect((await whoisLines(alice, "coder")).some((l) => /^budget: .*, paused$/.test(l))).toBe(true);
  });
});
