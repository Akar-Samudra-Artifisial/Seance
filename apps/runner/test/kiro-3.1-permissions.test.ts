// Regression (kiro-cli 3.1.0 demo): a +o coder editing `login.js` at the worktree root was rejected with
// `outside-worktree`, and a voiced `find . -name login.js -not -path "./node_modules/*"` with `protected-path`.
// Frames: test/fixtures/kiro-3.1-permission-frames.jsonl, recorded by spike S11 (spikes/acp/FINDINGS.md).
// Cause 1: kiro roots the diff `content[].path` at its PROCESS cwd (`__AGENTS__`), not the session cwd.
// Cause 2: the shell reference check treated a glob segment (`*`) as able to match AGENTS.md / .kiro.
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonObject } from "../src/acp/frames.js";
import type { PermissionAnswer, ToolInfo } from "../src/harness/harness.js";
import { resolveTool, ToolCache } from "../src/harness/tool-info.js";
import type { LogFields, RunnerLogger } from "../src/log.js";
import { handlePermissionRequest } from "../src/permissions/handler.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/kiro-3.1-permission-frames.jsonl", import.meta.url));
const OPTIONS = [
  { id: "allow_once", kind: "allow_once" },
  { id: "allow_always", kind: "allow_always" },
  { id: "reject_once", kind: "reject_once" },
] as const;

type Mode = "op" | "voice" | "none";
type Env = { readonly agentsDir: string; readonly wtReal: string; readonly wtLink: string };

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/**
 * Like the demo: the agents dir (kiro's process cwd) and the worktree are separate, and the worktree is
 * reached through a symlinked parent (`<base>/link -> <base>/real`, as /tmp -> /private/tmp on macOS).
 */
async function makeEnv(): Promise<Env> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "seance-k31-")));
  dirs.push(base);
  const agentsDir = join(base, "agents");
  await mkdir(join(agentsDir, ".kiro", "agents"), { recursive: true });
  await mkdir(join(base, "real", "fix-bug-124"), { recursive: true });
  await symlink(join(base, "real"), join(base, "link"));
  const wtReal = join(base, "real", "fix-bug-124");
  await writeFile(join(wtReal, "login.js"), "function login(user) {\n  return check(user); // bug\n}\n");
  return { agentsDir, wtReal, wtLink: join(base, "link", "fix-bug-124") };
}

type Frame = { readonly id?: string; readonly method: string; readonly params: JsonObject };

/** The fixture with its placeholders filled in for `env`. */
async function frames(env: Env): Promise<readonly Frame[]> {
  const text = (await readFile(FIXTURE, "utf8"))
    .split("__AGENTS__").join(env.agentsDir)
    .split("__WT_LINK__").join(env.wtLink)
    .split("__WT__").join(env.wtReal);
  return text
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Frame);
}

/** Replays the frames the way AcpHarness does: cache each tool_call(_update), resolve each permission request. */
async function requests(env: Env): Promise<readonly ToolInfo[]> {
  const cache = new ToolCache();
  const out: ToolInfo[] = [];
  for (const f of await frames(env)) {
    if (f.method === "session/update") {
      const u = f.params["update"] as JsonObject;
      const id = u["toolCallId"];
      if (typeof id === "string") cache.record(id, u);
    } else if (f.method === "session/request_permission") {
      const tc = f.params["toolCall"] as JsonObject;
      const id = tc["toolCallId"];
      out.push(resolveTool(tc, typeof id === "string" ? cache.get(id) : undefined));
    }
  }
  return out;
}

type Logged = { readonly msg: string; readonly fields: LogFields };

async function ask(
  worktree: string,
  mode: Mode,
  tool: ToolInfo,
  logs: Logged[] = [],
): Promise<PermissionAnswer> {
  const logger: RunnerLogger = {
    debug: () => undefined,
    info: (msg, fields = {}) => void logs.push({ msg, fields }),
    warn: (msg, fields = {}) => void logs.push({ msg, fields }),
    error: (msg, fields = {}) => void logs.push({ msg, fields }),
  };
  return handlePermissionRequest(
    {
      agent: "coder",
      channel: "#fix-bug-124",
      worktree,
      isPrivate: false,
      currentMembership: () => ({ op: mode === "op", voice: mode === "voice" }),
      logger,
    },
    { tool, options: OPTIONS },
  );
}

const reasonOf = (logs: readonly Logged[]): unknown =>
  logs.filter((l) => l.msg === "permission decision").at(-1)?.fields["reason"];

describe("kiro-cli 3.1 permission frames (spike S11)", () => {
  it("the fixture has the shape that caused the bug", async () => {
    const env = await makeEnv();
    const all = await frames(env);
    const edit = all.find(
      (f) => f.method === "session/update" && (f.params["update"] as JsonObject)["title"] === "Editing login.js",
    );
    const update = edit?.params["update"] as JsonObject;
    expect(JSON.stringify(update["content"])).toContain(`${env.agentsDir}/login.js`); // rooted at the process cwd
    expect((update["rawInput"] as JsonObject)["command"]).toBe("strReplace");
    expect(all.filter((f) => f.method === "session/request_permission")).toHaveLength(4);
  });

  it("resolves the four requests: find, edit login.js, a compound shell check, ls", async () => {
    const env = await makeEnv();
    const [find, edit, check, ls] = await requests(env);
    expect(find).toMatchObject({ kind: "execute", paths: [] });
    expect(find?.command).toContain("-not -path");
    expect(edit).toEqual({ kind: "edit", title: "Editing login.js", paths: ["./login.js"] });
    expect(check?.kind).toBe("execute");
    expect(ls).toEqual({ kind: "execute", title: "Running: ls", paths: [], command: "ls" });
  });

  it("+o may edit login.js at the worktree root (was: outside-worktree), whether the worktree is given real or via the symlink", async () => {
    const env = await makeEnv();
    const [, edit] = await requests(env);
    if (edit === undefined) throw new Error("no edit request in the fixture");
    for (const worktree of [env.wtReal, env.wtLink]) {
      const logs: Logged[] = [];
      expect(await ask(worktree, "op", edit, logs)).toEqual({ decision: "allow_once" });
      expect(reasonOf(logs)).toBeNull();
    }
    const logs: Logged[] = [];
    expect(await ask(env.wtReal, "voice", edit, logs)).toEqual({ decision: "reject_once" });
    expect(reasonOf(logs)).toBe("needs-op");
  });

  it("the same edit request without the cached tool_call is still an edit (`strReplace` is inferred)", async () => {
    const env = await makeEnv();
    const all = await frames(env);
    const req = all.find(
      (f) => f.method === "session/request_permission" && (f.params["toolCall"] as JsonObject)["title"] === "Editing login.js",
    );
    const tool = resolveTool(req?.params["toolCall"] as JsonObject, undefined);
    expect(tool).toEqual({ kind: "edit", title: "Editing login.js", paths: ["./login.js"] });
    expect(await ask(env.wtReal, "op", tool)).toEqual({ decision: "allow_once" });
  });

  it("a glob in `find -not -path` is no protected-path: +o allowed, +v needs-op", async () => {
    const env = await makeEnv();
    const [find] = await requests(env);
    if (find === undefined) throw new Error("no find request in the fixture");
    expect(await ask(env.wtReal, "op", find)).toEqual({ decision: "allow_once" });
    const logs: Logged[] = [];
    expect(await ask(env.wtReal, "voice", find, logs)).toEqual({ decision: "reject_once" });
    expect(reasonOf(logs)).toBe("needs-op");
    // The demo's exact command, with "./node_modules/*".
    const demo: ToolInfo = { ...find, command: 'find . -name login.js -not -path "./node_modules/*"' };
    const demoLogs: Logged[] = [];
    expect(await ask(env.wtReal, "voice", demo, demoLogs)).toEqual({ decision: "reject_once" });
    expect(reasonOf(demoLogs)).toBe("needs-op");
    expect(await ask(env.wtReal, "op", demo)).toEqual({ decision: "allow_once" });
  });

  it("`ls` and the compound check are allowed for +o", async () => {
    const env = await makeEnv();
    const [, , check, ls] = await requests(env);
    if (check === undefined || ls === undefined) throw new Error("missing shell requests in the fixture");
    expect(await ask(env.wtReal, "op", ls)).toEqual({ decision: "allow_once" });
    expect(await ask(env.wtReal, "op", check)).toEqual({ decision: "allow_once" });
  });

  it("logs every decision at info with the explaining fields and no file content", async () => {
    const env = await makeEnv();
    const [, edit] = await requests(env);
    if (edit === undefined) throw new Error("no edit request in the fixture");
    const logs: Logged[] = [];
    await ask(env.wtLink, "op", edit, logs);
    const rec = logs.find((l) => l.msg === "permission decision");
    expect(rec?.fields).toMatchObject({
      agent: "coder",
      channel: "#fix-bug-124",
      mode: "op",
      kind: "edit",
      title: "Editing login.js",
      rawPaths: ["./login.js"],
      canonicalPaths: [`${env.wtReal}/login.js`],
      worktree: env.wtReal,
      configuredWorktree: env.wtLink,
      decision: "allow_once",
      reason: null,
    });
    expect(JSON.stringify(logs)).not.toContain("check(user)"); // oldStr/newStr never logged
  });
});
