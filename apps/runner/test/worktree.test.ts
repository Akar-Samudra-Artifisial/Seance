import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { WorktreeConfinementError } from "../src/worktree/confine.js";
import { createGitRunner } from "../src/worktree/git.js";
import { sanitizeChannel } from "../src/worktree/sanitize.js";
import { scanConfig } from "../src/worktree/scan-config.js";
import { WorktreeError, WorktreeManager } from "../src/worktree/worktree-manager.js";
import { createTempRepo, type TempRepo } from "./fixtures/temp-repo.js";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd });
  return stdout;
}

type Env = { readonly repo: TempRepo; readonly root: string; readonly manager: WorktreeManager };

/** Runs `fn` with a repo, a workspaces root and a manager; always cleans up. */
async function withEnv(
  files: Readonly<Record<string, string>> | undefined,
  fn: (env: Env) => Promise<void>,
): Promise<void> {
  const repo = await createTempRepo(files);
  const base = await realpath(await mkdtemp(join(tmpdir(), "seance-runner-wt-")));
  const root = join(base, "workspaces");
  try {
    const manager = new WorktreeManager({ repo: repo.path, root, git: createGitRunner(repo.path) });
    await fn({ repo, root, manager });
  } finally {
    await rm(base, { recursive: true, force: true });
    await repo.dispose();
  }
}

async function tempDir(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "seance-runner-scan-")));
}

describe("WorktreeManager create, reuse, reset", () => {
  it("creates a worktree on branch seance/<sanitized>", async () => {
    await withEnv(undefined, async ({ repo, root, manager }) => {
      const info = await manager.ensure("#Dev");
      expect(info.created).toBe(true);
      expect(info.branch).toBe("seance/dev");
      expect(info.path).toBe(join(root, "dev"));
      expect(existsSync(join(info.realPath, "README.md"))).toBe(true);
      expect((await git(info.realPath, "rev-parse", "--abbrev-ref", "HEAD")).trim()).toBe("seance/dev");
      expect(await git(repo.path, "branch", "--list", "seance/*")).toContain("seance/dev");
    });
  });

  it("reuses the worktree without a second branch or worktree", async () => {
    await withEnv(undefined, async ({ repo, manager }) => {
      const first = await manager.ensure("#dev");
      const second = await manager.ensure("#DEV");
      expect(second.created).toBe(false);
      expect(second.realPath).toBe(first.realPath);
      const branches = (await git(repo.path, "branch", "--list", "seance/*")).trim().split("\n");
      expect(branches).toHaveLength(1);
      const trees = (await git(repo.path, "worktree", "list", "--porcelain"))
        .split("\n")
        .filter((l) => l.startsWith("worktree "));
      expect(trees).toHaveLength(2); // main repo + one channel
    });
  });

  it("reset discards uncommitted and untracked files and keeps the branch", async () => {
    await withEnv(undefined, async ({ repo, manager }) => {
      const info = await manager.ensure("#dev");
      await writeFile(join(info.realPath, "README.md"), "changed\n");
      await writeFile(join(info.realPath, "new.txt"), "x");
      await mkdir(join(info.realPath, "untracked-dir"));
      await writeFile(join(info.realPath, "untracked-dir", "f"), "x");
      await manager.reset("#dev");
      expect(await readFile(join(info.realPath, "README.md"), "utf8")).toBe("# fixture\n");
      expect(existsSync(join(info.realPath, "new.txt"))).toBe(false);
      expect(existsSync(join(info.realPath, "untracked-dir"))).toBe(false);
      expect(await git(repo.path, "branch", "--list", "seance/dev")).toContain("seance/dev");
    });
  });

  it("reports the reset (runner-services Req 6.2, 6.3): 0 files on a clean tree, the short HEAD sha", async () => {
    await withEnv(undefined, async ({ manager }) => {
      const info = await manager.ensure("#dev");
      const head = (await git(info.realPath, "rev-parse", "--short=7", "HEAD")).trim();
      expect(await manager.shortHead("#dev")).toBe(head);
      expect(await manager.reset("#dev")).toEqual({ target: head, filesReverted: 0 });
    });
  });

  it("counts modified and untracked files (every file of an untracked directory) before the reset", async () => {
    await withEnv(undefined, async ({ manager }) => {
      const info = await manager.ensure("#dev");
      await writeFile(join(info.realPath, "README.md"), "changed\n");
      await writeFile(join(info.realPath, "new.txt"), "x");
      await mkdir(join(info.realPath, "untracked-dir"));
      await writeFile(join(info.realPath, "untracked-dir", "a"), "x");
      await writeFile(join(info.realPath, "untracked-dir", "b"), "x");
      const report = await manager.reset("#dev");
      expect(report.filesReverted).toBe(4);
      expect(report.target).toMatch(/^[0-9a-f]{7}$/);
    });
  });

  it("shortHead is undefined for a channel without a worktree", async () => {
    await withEnv(undefined, async ({ manager }) => {
      expect(await manager.shortHead("#nowhere")).toBeUndefined();
    });
  });

  it("re-adds an existing branch when the worktree directory is gone", async () => {
    await withEnv(undefined, async ({ repo, manager }) => {
      const info = await manager.ensure("#dev");
      await git(repo.path, "worktree", "remove", "--force", info.realPath);
      const again = await manager.ensure("#dev");
      expect(again.created).toBe(true);
      expect(again.branch).toBe("seance/dev");
    });
  });
});

describe("WorktreeManager failures", () => {
  it("a failed worktree add names channel and operation and leaves the root unchanged", async () => {
    await withEnv(undefined, async ({ root, manager }) => {
      // `git worktree add` cannot start from a non-repository.
      const broken = new WorktreeManager({ repo: join(root, "nope"), root, git: createGitRunner(join(root, "nope")) });
      await mkdir(root, { recursive: true });
      const before = await readdir(root);
      const err = await broken.ensure("#dev").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WorktreeError);
      const werr = err as WorktreeError;
      expect(werr.channel).toBe("#dev");
      expect(werr.operation).toBe("worktree-add");
      expect(werr.message).toContain("#dev");
      expect(werr.message).toContain("worktree-add");
      expect(await readdir(root)).toEqual(before);
      // The healthy manager still works afterwards.
      expect((await manager.ensure("#dev")).created).toBe(true);
    });
  });

  it("a failed reset names channel and operation and leaves contents unchanged", async () => {
    await withEnv(undefined, async ({ repo, manager }) => {
      const info = await manager.ensure("#dev");
      await writeFile(join(info.realPath, "README.md"), "dirty\n");
      await writeFile(join(info.realPath, "keep.txt"), "keep");
      // A stale index.lock in the worktree's git dir makes `reset --hard` fail.
      const gitdir = (await git(info.realPath, "rev-parse", "--absolute-git-dir")).trim();
      expect(gitdir.startsWith(repo.path)).toBe(true);
      await writeFile(join(gitdir, "index.lock"), "");
      const err = await manager.reset("#dev").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WorktreeError);
      const werr = err as WorktreeError;
      expect(werr.channel).toBe("#dev");
      expect(werr.operation).toBe("reset");
      expect(werr.message).toContain("#dev");
      expect(await readFile(join(info.realPath, "README.md"), "utf8")).toBe("dirty\n");
      expect(await readFile(join(info.realPath, "keep.txt"), "utf8")).toBe("keep");
    });
  });

  it("refuses a worktree path that is a symlink leaving the root", async () => {
    await withEnv(undefined, async ({ root, manager }) => {
      const outside = await tempDir();
      try {
        await mkdir(root, { recursive: true });
        await symlink(outside, join(root, "evil"));
        const err = await manager.ensure("#evil").catch((e: unknown) => e);
        expect(err).toBeInstanceOf(WorktreeConfinementError);
        expect((err as WorktreeConfinementError).channel).toBe("#evil");
        expect(await readdir(outside)).toEqual([]);
        await expect(manager.reset("#evil")).rejects.toBeInstanceOf(WorktreeConfinementError);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it("refuses an existing directory that is not a worktree root", async () => {
    await withEnv(undefined, async ({ root, manager }) => {
      await mkdir(join(root, "plain"), { recursive: true });
      const err = await manager.ensure("#plain").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WorktreeError);
      expect((err as WorktreeError).channel).toBe("#plain");
    });
  });
});

describe("hostile channel names", () => {
  const names = ["#a/b", "#../../etc", "..", "#a\0b", "#a b", "#x; touch pwned", "#$(touch pwned)", "#`touch pwned`", "#-rf"];

  it.each(names)("%j stays inside the root and never reaches a shell", async (name) => {
    await withEnv(undefined, async ({ repo, root, manager }) => {
      const info = await manager.ensure(name);
      expect(info.realPath.startsWith(`${root}/`)).toBe(true);
      expect(info.branch).toBe(`seance/${sanitizeChannel(name)}`);
      expect(sanitizeChannel(name)).toMatch(/^[a-z0-9_-]{1,64}$/);
      expect(existsSync(join(process.cwd(), "pwned"))).toBe(false);
      expect(existsSync(join(root, "pwned"))).toBe(false);
      expect(existsSync(join(repo.path, "pwned"))).toBe(false);
      expect(existsSync(join(info.realPath, "pwned"))).toBe(false);
      expect(await readdir(root)).toEqual([sanitizeChannel(name)]);
    });
  });
});

const CONFIG_FILES: Readonly<Record<string, string>> = {
  "README.md": "# fixture\n",
  "AGENTS.md": "root rules\n",
  ".kiro/skills/x/SKILL.md": "skill\n",
  "docs/deep/AGENTS.md": "deep rules\n",
  "packages/x/.kiro/steering/a.md": "steering\n",
  "packages/x/src/code.ts": "export {};\n",
};

/** Commits `agents.md` through plumbing so it also exists on case-insensitive file systems. */
async function commitLowercaseAgents(repoPath: string): Promise<void> {
  const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
    const child = execFile("git", ["hash-object", "-w", "--stdin"], { cwd: repoPath }, (e, out) =>
      e ? reject(e) : resolve({ stdout: out }),
    );
    child.stdin?.end("lower rules\n");
  });
  await git(repoPath, "update-index", "--add", "--cacheinfo", `100644,${stdout.trim()},agents.md`);
  await git(
    repoPath,
    "-c", "user.name=Seance Test",
    "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false",
    "commit", "--quiet", "-m", "lowercase agents",
  );
}

describe("config exclusion", () => {
  it("creates a worktree without any agent config at any depth", async () => {
    await withEnv(CONFIG_FILES, async ({ repo, manager }) => {
      await commitLowercaseAgents(repo.path);
      const tracked = (await git(repo.path, "ls-files")).split("\n");
      expect(tracked).toContain("agents.md");
      expect(tracked).toContain("docs/deep/AGENTS.md");
      expect(tracked).toContain(".kiro/skills/x/SKILL.md");
      expect(tracked).toContain("packages/x/.kiro/steering/a.md");

      const info = await manager.ensure("#dev");
      expect(await scanConfig(info.realPath)).toEqual([]);
      expect(existsSync(join(info.realPath, "AGENTS.md"))).toBe(false);
      expect(existsSync(join(info.realPath, ".kiro"))).toBe(false);
      expect(existsSync(join(info.realPath, "docs", "deep", "AGENTS.md"))).toBe(false);
      expect(existsSync(join(info.realPath, "packages", "x", ".kiro"))).toBe(false);
      // Regular files are still checked out.
      expect(existsSync(join(info.realPath, "README.md"))).toBe(true);
      expect(existsSync(join(info.realPath, "packages", "x", "src", "code.ts"))).toBe(true);
    });
  });

  it.each([
    "AGENTS.md",
    "agents.md",
    "Agents.MD",
    ".kiro/skills/x/SKILL.md",
    ".KIRO/steering/a.md",
    "sub/deep/AGENTS.md",
    "sub/.kiro/x.md",
  ])("ensure refuses a planted %s with config-exclusion naming the path", async (planted) => {
    await withEnv(undefined, async ({ manager }) => {
      const info = await manager.ensure("#dev");
      const abs = join(info.realPath, planted);
      await mkdir(join(abs, ".."), { recursive: true });
      await writeFile(abs, "planted\n");
      const err = await manager.ensure("#dev").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WorktreeError);
      const werr = err as WorktreeError;
      expect(werr.operation).toBe("config-exclusion");
      expect(werr.channel).toBe("#dev");
      const top = planted.split("/").find((p) => p.toLowerCase() === ".kiro" || p.toLowerCase() === "agents.md") ?? "";
      expect(werr.detail).toContain(top);
    });
  });

  it("guardBeforePrompt removes planted entries and reports them", async () => {
    await withEnv(undefined, async ({ manager }) => {
      const info = await manager.ensure("#dev");
      await writeFile(join(info.realPath, "AGENTS.md"), "x");
      await mkdir(join(info.realPath, "a", ".kiro"), { recursive: true });
      const result = await manager.guardBeforePrompt("#dev");
      expect(result).toEqual({ ok: false, paths: ["AGENTS.md", join("a", ".kiro")] });
      expect(await scanConfig(info.realPath)).toEqual([]);
      expect(await manager.guardBeforePrompt("#dev")).toEqual({ ok: true });
    });
  });
});

describe("scanConfig", () => {
  it("finds entries at depth 0 and depth 3 in any letter case", async () => {
    const dir = await tempDir();
    try {
      await writeFile(join(dir, "Agents.MD"), "");
      await mkdir(join(dir, "a", "b", "c", ".KIRO"), { recursive: true });
      await mkdir(join(dir, "a", "b", "agents.md"), { recursive: true });
      expect(await scanConfig(dir)).toEqual(
        [join("Agents.MD"), join("a", "b", "agents.md"), join("a", "b", "c", ".KIRO")].sort(),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("ignores lookalikes", async () => {
    const dir = await tempDir();
    try {
      for (const name of ["AGENTS.md.bak", ".kiroish", "xAGENTS.md", "AGENTS.mdx", "kiro", "AGENTS_md"]) {
        await writeFile(join(dir, name), "");
      }
      expect(await scanConfig(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports a name match whether it is a file, a directory or a symlink", async () => {
    const dir = await tempDir();
    try {
      await writeFile(join(dir, "AGENTS.md"), "");
      await mkdir(join(dir, "d"));
      await mkdir(join(dir, "d", "AGENTS.md"));
      await writeFile(join(dir, "target"), "");
      await symlink("target", join(dir, "s-agents"));
      await mkdir(join(dir, "e"));
      await symlink("../target", join(dir, "e", "agents.md"));
      await symlink("target", join(dir, ".kiro"));
      expect(await scanConfig(dir)).toEqual(
        ["AGENTS.md", ".kiro", join("d", "AGENTS.md"), join("e", "agents.md")].sort(),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not follow a symlink to a directory holding AGENTS.md", async () => {
    const dir = await tempDir();
    const outside = await tempDir();
    try {
      await writeFile(join(outside, "AGENTS.md"), "");
      await symlink(outside, join(dir, "link"));
      expect(await scanConfig(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("skips the root .git but not a nested one", async () => {
    const dir = await tempDir();
    try {
      await mkdir(join(dir, ".git", "x"), { recursive: true });
      await writeFile(join(dir, ".git", "AGENTS.md"), "");
      expect(await scanConfig(dir)).toEqual([]);
      await mkdir(join(dir, "sub", ".git"), { recursive: true });
      await writeFile(join(dir, "sub", ".git", "AGENTS.md"), "");
      // agent-sandbox review finding 1: a nested .git is itself refused (and not descended into),
      // so the entry is reported as `sub/.git`, not as the AGENTS.md inside it.
      expect(await scanConfig(dir)).toEqual([join("sub", ".git")]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports a nested .git as a directory or a file, and .gitmodules at any depth, any case (review finding 1)", async () => {
    const dir = await tempDir();
    try {
      await mkdir(join(dir, "a", ".git"), { recursive: true });
      await mkdir(join(dir, "b"), { recursive: true });
      await writeFile(join(dir, "b", ".GIT"), "gitdir: /elsewhere\n");
      await writeFile(join(dir, ".gitmodules"), "");
      await mkdir(join(dir, "c", "d"), { recursive: true });
      await writeFile(join(dir, "c", "d", ".GitModules"), "");
      await writeFile(join(dir, ".gitignore"), ""); // an ordinary dotfile stays allowed
      await writeFile(join(dir, ".github"), "");
      expect(await scanConfig(dir)).toEqual(
        [".gitmodules", join("a", ".git"), join("b", ".GIT"), join("c", "d", ".GitModules")].sort(),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not descend into a found nested .git", async () => {
    const dir = await tempDir();
    try {
      await mkdir(join(dir, "sub", ".git", "deep"), { recursive: true });
      await writeFile(join(dir, "sub", ".git", "deep", "AGENTS.md"), "");
      expect(await scanConfig(dir)).toEqual([join("sub", ".git")]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not descend into a found .kiro", async () => {
    const dir = await tempDir();
    try {
      await mkdir(join(dir, ".kiro", "inner"), { recursive: true });
      await writeFile(join(dir, ".kiro", "inner", "AGENTS.md"), "");
      expect(await scanConfig(dir)).toEqual([".kiro"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
