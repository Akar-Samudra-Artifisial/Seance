// Task 22.4: IRC modes decide what an Agent may do (Requirement 8), end to end.
// A real Runner over an in-process ircd drives the Fake_Agent, which raises scripted
// `session/request_permission` frames; the Fake_Agent records its answers in a dump file.
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeAllFixtures, startIntegration } from "./integration.js";
import type { IntegrationFixture, IrcTestClient } from "./integration.js";

const CHANNEL = "#perm";
const NOTICE_RE = /^:coder!\S* NOTICE #perm :ops: coder denied /;

type Answer = { readonly id: string | number; readonly optionId: string | null };

const isAnswerList = (v: unknown): v is readonly Answer[] =>
  Array.isArray(v) &&
  v.every(
    (a: unknown) =>
      typeof a === "object" &&
      a !== null &&
      "id" in a &&
      "optionId" in a &&
      (typeof (a as { id: unknown }).id === "string" || typeof (a as { id: unknown }).id === "number") &&
      ((a as { optionId: unknown }).optionId === null || typeof (a as { optionId: unknown }).optionId === "string"),
  );

const perm = (kind: string, title: string, extra: { path?: string; command?: string }, ids?: "number") => ({
  permission: { toolCall: { kind, title, ...extra }, ...(ids === undefined ? {} : { ids }) },
});

const LONG_TITLE = `${"é".repeat(300)} ${"x".repeat(300)}`;

const SCRIPT = {
  turns: [
    {
      match: "TURN_VOICE",
      steps: [
        perm("edit", "write voice-file", { path: "src/a.txt" }, "number"),
        perm("read", "read voice-file", { path: "docs/notes.txt" }),
        perm("execute", "run voice-shell", { command: "ls" }),
        { chunk: "done-voice\n" },
      ],
    },
    {
      match: "TURN_OP",
      steps: [
        perm("edit", "write inside", { path: "src/a.txt" }),
        perm("edit", "write dotdot", { path: "../escape.txt" }),
        perm("edit", "write absolute", { path: "/etc/hosts" }),
        perm("edit", "write agentsmd", { path: "AGENTS.md" }),
        perm("edit", "write kirodir", { path: ".Kiro/steering/x.md" }),
        perm("execute", "run ls", { command: "ls" }),
        perm("execute", "run forcepush", { command: "git push --force origin main" }),
        perm("execute", "run catagents", { command: "cat agents.md" }),
        perm("edit", "write symlink", { path: "link/x.txt" }),
        { chunk: "done-op\n" },
      ],
    },
    {
      match: "TURN_DOWN",
      steps: [
        perm("edit", LONG_TITLE, { path: "src/a.txt" }),
        perm("execute", "run down-shell", { command: "ls" }),
        { chunk: "done-down\n" },
      ],
    },
  ],
} as const;

describe("permissions (integration)", { timeout: 40_000 }, () => {
  let fixture: IntegrationFixture;
  let alice: IrcTestClient;
  let scratch: string;
  let dumpFile: string;
  let savedDump: string | undefined;

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), "seance-perm-"));
    dumpFile = join(scratch, "dump.json");
    savedDump = process.env["FAKE_AGENT_DUMP_FILE"];
    process.env["FAKE_AGENT_DUMP_FILE"] = dumpFile;
    fixture = await startIntegration({ script: SCRIPT, floodBurst: 10_000 });
    alice = await fixture.connectClient("alice");
    await alice.join(CHANNEL);
    alice.send(`INVITE coder ${CHANNEL}`);
    await alice.waitFor(/^:\S+ 341 /);
    await alice.waitFor(/^:coder!\S* JOIN /);
    await sessionOpen();
  }, 40_000);

  afterEach(async () => {
    try {
      await closeAllFixtures();
    } finally {
      if (savedDump === undefined) delete process.env["FAKE_AGENT_DUMP_FILE"];
      else process.env["FAKE_AGENT_DUMP_FILE"] = savedDump;
      await rm(scratch, { recursive: true, force: true });
    }
  }, 40_000);

  // The fixture raises the ircd flood burst far above what this test sends, so the
  // flood bucket never drains and no real-time pacing is needed.
  /** Sends one line. */
  function send(line: string): void {
    alice.send(line);
  }

  /** Sends a MODE change at the paced rate and waits for its echo. */
  async function mode(change: string): Promise<void> {
    send(`MODE ${CHANNEL} ${change} coder`);
    await alice.waitFor(new RegExp(` MODE #perm ${change.replace(/[+-]/g, "\\$&")} coder`));
  }

  /** Polls `/whois coder` until the channel Session is listed (no other readiness signal exists). */
  async function sessionOpen(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (attempt > 0) await alice.expectNone(/^never$/, 50); // short poll interval, not flood pacing
      send("WHOIS coder");
      const seen = await alice.waitFor(/^:\S+ 318 /);
      const lines = alice.lines;
      const end = lines.lastIndexOf(seen);
      let open = false;
      for (let i = end - 1; i >= 0 && !/ 311 /.test(lines[i] ?? ""); i -= 1) {
        if (/ 320 \S+ coder :credits: #perm /i.test(lines[i] ?? "")) open = true;
      }
      if (open) return;
    }
    throw new Error("coder never opened a Session in #perm");
  }

  async function turn(token: string, done: string): Promise<void> {
    send(`PRIVMSG ${CHANNEL} :${token}`);
    await alice.waitFor(new RegExp(`^:coder!\\S* PRIVMSG #perm .*${done}`));
  }

  async function answers(): Promise<readonly Answer[]> {
    const dump: unknown = JSON.parse(await readFile(dumpFile, "utf8"));
    const list = (dump as { permissionAnswers?: unknown }).permissionAnswers;
    if (!isAnswerList(list)) throw new Error("dump file has no permissionAnswers list");
    return list;
  }

  const options = async (): Promise<readonly (string | null)[]> => (await answers()).map((a) => a.optionId);

  const notices = (): readonly string[] => alice.lines.filter((l) => NOTICE_RE.test(l));

  it("+v: rejects write and shell with one NOTICE each, allows an in-worktree read, echoes numeric ids", async () => {
    await mode("+v");
    await turn("TURN_VOICE", "done-voice");

    const got = await answers();
    expect(got.map((a) => a.optionId)).toEqual(["reject_once", "allow_once", "reject_once"]);
    // Requirement 8.9: the id is returned unchanged (number for the first, string for the others).
    expect(typeof got[0]?.id).toBe("number");
    expect(typeof got[1]?.id).toBe("string");

    const sent = notices();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain("write voice-file: needs-op");
    expect(sent[1]).toContain("run voice-shell: needs-op");
  });

  it("+o: allows a write inside the worktree and rejects outside, protected, deny-listed and symlinked paths", async () => {
    const outside = join(scratch, "outside");
    await mkdir(outside);
    const [worktreeName] = await readdir(fixture.workspaces);
    if (worktreeName === undefined) throw new Error("no worktree directory was created");
    await symlink(outside, join(fixture.workspaces, worktreeName, "link"));

    await mode("+o");
    await turn("TURN_OP", "done-op");

    expect(await options()).toEqual([
      "allow_once", // src/a.txt inside the worktree
      "reject_once", // ../escape.txt
      "reject_once", // /etc/hosts
      "reject_once", // AGENTS.md
      "reject_once", // .Kiro/steering/x.md (case-insensitive)
      "allow_once", // ls
      "reject_once", // git push --force
      "reject_once", // cat agents.md
      "reject_once", // symlink escaping the worktree
    ]);

    const sent = notices();
    const expected: readonly (readonly [string, string])[] = [
      ["write dotdot", "outside-worktree"],
      ["write absolute", "outside-worktree"],
      ["write agentsmd", "protected-path"],
      ["write kirodir", "protected-path"],
      ["run forcepush", "deny-list"],
      ["run catagents", "protected-path"],
      ["write symlink", "outside-worktree"],
    ];
    expect(sent).toHaveLength(expected.length);
    expected.forEach(([title, reason], i) => {
      expect(sent[i]).toContain(`denied ${title}: ${reason}`);
    });
    // The escape target was never written (the Fake_Agent writes nothing, and the runner allowed nothing).
    expect(await readdir(outside)).toEqual([]);
  });

  it("a mode change between two requests changes the second answer, using the mode at request time", async () => {
    await mode("+v");
    await turn("TURN_VOICE", "done-voice");
    expect((await options())[0]).toBe("reject_once");

    await mode("+o");
    await turn("TURN_OP", "done-op");
    const afterOp = await options();
    expect(afterOp[3]).toBe("allow_once"); // first request of the +o turn: same write, now allowed

    await mode("-o");
    await turn("TURN_DOWN", "done-down");
    const final = await options();
    expect(final.slice(afterOp.length)).toEqual(["reject_once", "reject_once"]);
  });

  it("each denial is one channel NOTICE under 512 bytes, even for an oversized multibyte tool title", async () => {
    await mode("+v");
    await mode("+o");
    await mode("-o");
    await turn("TURN_DOWN", "done-down");

    const sent = notices();
    expect(sent).toHaveLength(2);
    for (const line of sent) {
      expect(Buffer.byteLength(line, "utf8") + 2).toBeLessThanOrEqual(512);
      expect(line).toContain("needs-op");
    }
    expect(await options()).toEqual(["reject_once", "reject_once"]);
  });
});
