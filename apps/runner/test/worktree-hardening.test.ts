// Regression tests: committed agent config, case-insensitive sparse patterns, idempotent sparse-checkout.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createGitRunner } from "../src/worktree/git.js";
import { scanConfig } from "../src/worktree/scan-config.js";
import { protectedPaths, SPARSE_PATTERNS, WorktreeError, WorktreeManager } from "../src/worktree/worktree-manager.js";
import { createTempRepo, type TempRepo } from "./fixtures/temp-repo.js";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", args, { cwd })).stdout;
const IDENT = ["-c", "user.name=Seance Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false"];

async function withEnv(
  files: Readonly<Record<string, string>> | undefined,
  fn: (env: { repo: TempRepo; manager: WorktreeManager }) => Promise<void>,
): Promise<void> {
  const repo = await createTempRepo(files);
  const base = await realpath(await mkdtemp(join(tmpdir(), "seance-wt-hard-")));
  try {
    const manager = new WorktreeManager({ repo: repo.path, root: join(base, "ws"), git: createGitRunner(repo.path) });
    await fn({ repo, manager });
  } finally {
    await rm(base, { recursive: true, force: true });
    await repo.dispose();
  }
}

/** Does what a +o agent could do: write the file, force-add it past the sparse filter and commit. */
async function agentCommits(worktree: string, rel: string): Promise<void> {
  const abs = join(worktree, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, "injected\n");
  await git(worktree, "add", "--force", "--sparse", "--", rel);
  await git(worktree, ...IDENT, "commit", "--quiet", "-m", `add ${rel}`);
}

describe("protectedPaths", () => {
  it("matches AGENTS.md and .kiro at any depth, case-insensitively, and nothing else", () => {
    const names = ["a/b/Agents.MD", ".KIRO/x", "src/.kiro/y/z", "AGENTS.md", "ok.ts", "AGENTS.md.bak", "kiro/x"].join("\0");
    expect(protectedPaths(`${names}\0`)).toEqual(["a/b/Agents.MD", ".KIRO/x", "src/.kiro/y/z", "AGENTS.md"].sort());
  });
});

describe("committed agent config", () => {
  it.each(["AGENTS.md", "docs/Agents.MD", "pkg/.Kiro/steering/a.md"])(
    "guardBeforePrompt rejects a commit touching %s and resets to the base",
    async (planted) => {
      await withEnv(undefined, async ({ manager }) => {
        const info = await manager.ensure("#dev");
        const base = (await git(info.realPath, "rev-parse", "HEAD")).trim();
        await agentCommits(info.realPath, "src/ok.txt");
        expect(await manager.guardBeforePrompt("#dev")).toEqual({ ok: true }); // harmless commits stay
        await agentCommits(info.realPath, planted);

        const result = await manager.guardBeforePrompt("#dev");
        expect(result.ok).toBe(false);
        // The committed path is reported (a scanned `.kiro` directory may be listed as well).
        expect(result.ok === false ? result.paths : []).toContain(planted);
        expect((await git(info.realPath, "rev-parse", "HEAD")).trim()).toBe(base);
        expect(existsSync(join(info.realPath, "src", "ok.txt"))).toBe(false);
        expect(await scanConfig(info.realPath)).toEqual([]);
        expect(await manager.guardBeforePrompt("#dev")).toEqual({ ok: true });
      });
    },
  );

  it("ensure on an existing worktree rejects such a commit with config-exclusion and resets to the base", async () => {
    await withEnv(undefined, async ({ manager }) => {
      const info = await manager.ensure("#dev");
      const base = (await git(info.realPath, "rev-parse", "HEAD")).trim();
      await agentCommits(info.realPath, "sub/AGENTS.md");
      const err = await manager.ensure("#dev").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WorktreeError);
      expect((err as WorktreeError).operation).toBe("config-exclusion");
      expect((err as WorktreeError).detail).toContain("sub/AGENTS.md");
      expect((await git(info.realPath, "rev-parse", "HEAD")).trim()).toBe(base);
      expect((await manager.ensure("#dev")).created).toBe(false);
    });
  });

  it("reset goes back to the base when a commit touched agent config, else keeps commits", async () => {
    await withEnv(undefined, async ({ manager }) => {
      const info = await manager.ensure("#dev");
      const base = (await git(info.realPath, "rev-parse", "HEAD")).trim();
      await agentCommits(info.realPath, "src/keep.txt");
      await manager.reset("#dev");
      expect((await git(info.realPath, "rev-parse", "HEAD")).trim()).not.toBe(base);
      await agentCommits(info.realPath, ".kiro/hooks/x.json");
      const report = await manager.reset("#dev");
      expect((await git(info.realPath, "rev-parse", "HEAD")).trim()).toBe(base);
      // runner-services Req 6.2: the report names the base it went back to.
      expect(report.target).toBe(base.slice(0, 7));
    });
  });
});

describe("ensure is single-flight per channel", () => {
  it("concurrent ensures share one creation and one worktree instead of racing on `git worktree add`", async () => {
    await withEnv(undefined, async ({ repo, manager }) => {
      const results = await Promise.all([manager.ensure("#dev"), manager.ensure("#DEV"), manager.ensure("#dev")]);
      expect(new Set(results.map((r) => r.realPath)).size).toBe(1);
      expect(results.every((r) => r.created)).toBe(true); // one shared creation
      const trees = (await git(repo.path, "worktree", "list", "--porcelain"))
        .split("\n")
        .filter((l) => l.startsWith("worktree "));
      expect(trees).toHaveLength(2);
      // Afterwards the entry is gone: the next ensure reuses the existing worktree.
      expect((await manager.ensure("#dev")).created).toBe(false);
    });
  });

  it("a failed ensure is not cached: the next call tries again", async () => {
    await withEnv(undefined, async ({ manager }) => {
      const broken = new WorktreeManager({ repo: "/nonexistent-seance-repo", root: "/nonexistent-seance-root/ws", git: createGitRunner("/nonexistent-seance-repo") });
      const first = broken.ensure("#dev");
      const second = broken.ensure("#dev");
      expect(second).toBe(first);
      await expect(first).rejects.toBeInstanceOf(WorktreeError);
      const again = broken.ensure("#dev");
      expect(again).not.toBe(first);
      await expect(again).rejects.toBeInstanceOf(WorktreeError);
      expect((await manager.ensure("#dev")).created).toBe(true);
    });
  });

  it("different channels run independently", async () => {
    await withEnv(undefined, async ({ manager }) => {
      const [a, b] = await Promise.all([manager.ensure("#a"), manager.ensure("#b")]);
      expect(a.realPath).not.toBe(b.realPath);
    });
  });
});

describe("sparse-checkout patterns", () => {
  it("are case-insensitive", () => {
    expect(SPARSE_PATTERNS).toContain("![Aa][Gg][Ee][Nn][Tt][Ss].md");
    expect(SPARSE_PATTERNS).toContain("!**/[Aa][Gg][Ee][Nn][Tt][Ss].md");
  });

  it("keep differently-cased agent config out of a fresh worktree", async () => {
    await withEnv({ "README.md": "# r\n", "Agents.MD": "x", ".KIRO/s.md": "x", "p/aGeNtS.md": "x", "p/code.ts": "x" }, async ({ repo, manager }) => {
      expect(await git(repo.path, "ls-files")).toContain("Agents.MD");
      const info = await manager.ensure("#dev");
      expect(await scanConfig(info.realPath)).toEqual([]);
      expect(existsSync(join(info.realPath, "p", "code.ts"))).toBe(true);
    });
  });

  it("are re-applied when the worktree already exists", async () => {
    await withEnv(undefined, async ({ manager }) => {
      const info = await manager.ensure("#dev");
      await git(info.realPath, "sparse-checkout", "set", "--no-cone", "/*", "!AGENTS.md");
      expect(await git(info.realPath, "sparse-checkout", "list")).not.toContain("[Aa]");
      await manager.ensure("#dev");
      expect(await git(info.realPath, "sparse-checkout", "list")).toContain("[Aa][Gg][Ee][Nn][Tt][Ss].md");
      await manager.ensure("#dev"); // idempotent
      const list = (await git(info.realPath, "sparse-checkout", "list")).trim().split("\n");
      expect(list).toEqual([...SPARSE_PATTERNS]);
    });
  });
});
