// Regression: real kiro-cli sends `session/request_permission` without `toolCall.kind`; kind and paths
// come from earlier `session/update` frames for the same toolCallId (frames captured from kiro-cli 3.0.0).
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonObject } from "../src/acp/frames.js";
import { resolveTool, ToolCache, inferKind } from "../src/harness/tool-info.js";
import type { PermissionAnswer } from "../src/harness/harness.js";
import type { RunnerLogger } from "../src/log.js";
import { handlePermissionRequest } from "../src/permissions/handler.js";

const quiet: RunnerLogger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
const FRAMES = fileURLToPath(new URL("./fixtures/kiro-3.0-permission-frames.jsonl", import.meta.url));
const OPTIONS = [
  { id: "allow_once", kind: "allow_once" },
  { id: "allow_always", kind: "allow_always" },
  { id: "reject_once", kind: "reject_once" },
] as const;

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const worktree = async (): Promise<string> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "seance-toolinfo-")));
  dirs.push(dir);
  return dir;
};

type Frames = { toolCall: JsonObject; permission: JsonObject; update: JsonObject };

/**
 * The three captured frames with the worktree path substituted; optionally with another file name.
 * `__AGENTS__` (kiro's process cwd, where it wrongly roots the diff path) becomes a directory outside `wt`.
 */
async function realFrames(wt: string, file = "AGENTS.md"): Promise<Frames> {
  const text = (await readFile(FRAMES, "utf8"))
    .split("__AGENTS__").join("/srv/seance/agents")
    .split("__WT__").join(wt)
    .split("AGENTS.md").join(file);
  const [a, b, c] = text.trim().split("\n").map((l) => JSON.parse(l) as { params: JsonObject });
  const upd = (f: { params: JsonObject } | undefined): JsonObject => (f?.params["update"] ?? {}) as JsonObject;
  return {
    toolCall: upd(a),
    permission: (b?.params["toolCall"] ?? {}) as JsonObject,
    update: upd(c),
  };
}

const ask = async (
  wt: string,
  mode: "op" | "voice" | "none",
  tool: ReturnType<typeof resolveTool>,
): Promise<PermissionAnswer> =>
  handlePermissionRequest(
    {
      agent: "coder",
      worktree: wt,
      isPrivate: false,
      currentMembership: () => (mode === "none" ? { op: false, voice: false } : { op: mode === "op", voice: mode === "voice" }),
      logger: quiet,
    },
    { tool, options: OPTIONS },
  );

describe("real kiro frames", () => {
  it("the permission request alone has no kind; `edit` is inferred from rawInput", async () => {
    const f = await realFrames("/w");
    expect(f.permission["kind"]).toBeUndefined();
    expect(resolveTool(f.permission, undefined)).toEqual({ kind: "edit", title: "Creating AGENTS.md", paths: ["AGENTS.md"] });
  });

  it("resolves kind and paths from the cached tool_call; the diff path (rooted at the process cwd) is ignored", async () => {
    const wt = await worktree();
    const f = await realFrames(wt);
    const cache = new ToolCache();
    cache.record("toolu_bdrk_01Jvq1gJ84xoTVBaSsYqxWn8", f.toolCall);
    const tool = resolveTool(f.permission, cache.get("toolu_bdrk_01Jvq1gJ84xoTVBaSsYqxWn8"));
    expect(tool.kind).toBe("edit");
    expect(tool.paths).toEqual(["AGENTS.md"]);
    expect(tool.command).toBeUndefined(); // "create" is the edit tool's verb, not a shell command
  });

  it("a tool_call_update only adds to what is known", async () => {
    const wt = await worktree();
    const f = await realFrames(wt);
    const cache = new ToolCache();
    cache.record("t", f.toolCall);
    const merged = cache.record("t", f.update);
    expect(merged.kind).toBe("edit");
    expect(merged.paths).toEqual(["AGENTS.md"]);
  });

  it("an AGENTS.md write is rejected for +o as protected, a plain file is allowed for +o and needs-op for +v", async () => {
    const wt = await worktree();
    const protectedFrames = await realFrames(wt);
    const cache = new ToolCache();
    cache.record("toolu_bdrk_01Jvq1gJ84xoTVBaSsYqxWn8", protectedFrames.toolCall);
    const agentsTool = resolveTool(protectedFrames.permission, cache.get("toolu_bdrk_01Jvq1gJ84xoTVBaSsYqxWn8"));
    expect(await ask(wt, "op", agentsTool)).toEqual({ decision: "reject_once" });

    const plain = await realFrames(wt, "hello.txt");
    const c2 = new ToolCache();
    c2.record("toolu_bdrk_01Jvq1gJ84xoTVBaSsYqxWn8", plain.toolCall);
    const tool = resolveTool(plain.permission, c2.get("toolu_bdrk_01Jvq1gJ84xoTVBaSsYqxWn8"));
    expect(await ask(wt, "op", tool)).toEqual({ decision: "allow_once" });
    expect(await ask(wt, "voice", tool)).toEqual({ decision: "reject_once" });
    expect(await ask(wt, "none", tool)).toEqual({ decision: "reject_once" });
  });
});

describe("inference from rawInput when nothing was cached", () => {
  const frame = (rawInput: JsonObject, title = "t"): JsonObject => ({ toolCallId: "x", title, rawInput });

  it.each(["create", "str_replace", "insert", "write"])("command %s with a path is an edit of that path", (command) => {
    expect(resolveTool(frame({ command, path: "src/a.ts" }), undefined)).toEqual({ kind: "edit", title: "t", paths: ["src/a.ts"] });
  });

  it("a shell command string is execute and keeps the command", () => {
    expect(resolveTool(frame({ command: "git status" }), undefined)).toEqual({
      kind: "execute",
      title: "t",
      paths: [],
      command: "git status",
    });
  });

  it.each(["read", "ls", "glob", "grep"])("%s with a path is a read", (command) => {
    expect(resolveTool(frame({ command, path: "src" }), undefined)).toMatchObject({ kind: "read", paths: ["src"] });
  });

  it("a bare `ls` (no path) is a shell command, the stricter class", () => {
    expect(inferKind({ command: "ls" })).toBe("execute");
  });

  it("fails closed as `other` when nothing matches", async () => {
    expect(resolveTool(frame({}), undefined).kind).toBe("other");
    expect(resolveTool({ toolCallId: "x" }, undefined).kind).toBe("other");
    expect(resolveTool(frame({ command: "   " }), undefined).kind).toBe("other");
    const wt = await worktree();
    expect(await ask(wt, "op", resolveTool(frame({ path: "a.txt" }), undefined))).toEqual({ decision: "reject_once" });
  });

  it("an explicit or cached kind wins over inference", () => {
    expect(resolveTool({ ...frame({ command: "create", path: "a" }), kind: "read" }, undefined).kind).toBe("read");
    const cache = new ToolCache();
    cache.record("x", { toolCallId: "x", kind: "execute", rawInput: { command: "ls" } });
    expect(resolveTool(frame({ command: "ls" }), cache.get("x")).kind).toBe("execute");
  });

  it("a shell command is still denied by the deny list for +o", async () => {
    const wt = await worktree();
    const tool = resolveTool(frame({ command: "git push --force origin main" }), undefined);
    expect(await ask(wt, "op", tool)).toEqual({ decision: "reject_once" });
    expect(await ask(wt, "op", resolveTool(frame({ command: "ls" }), undefined))).toEqual({ decision: "allow_once" });
  });
});

describe("ToolCache", () => {
  it("is bounded: the oldest entries are dropped", () => {
    const cache = new ToolCache(4);
    for (let i = 0; i < 10; i += 1) cache.record(`t${i}`, { kind: "read" });
    expect(cache.size).toBe(4);
    expect(cache.get("t0")).toBeUndefined();
    expect(cache.get("t9")?.kind).toBe("read");
  });

  it("clear() empties it", () => {
    const cache = new ToolCache();
    cache.record("t", { kind: "edit" });
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("t")).toBeUndefined();
  });
});
