import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface TempRepo {
  /** Real path of the repository root. */
  readonly path: string;
  /** Removes the directory; safe to call more than once. */
  readonly dispose: () => Promise<void>;
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  try {
    await run("git", [...args], { cwd });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${msg}`);
  }
}

/** Creates a git repository with one commit in `os.tmpdir()`. */
export async function createTempRepo(files: Readonly<Record<string, string>> = { "README.md": "# fixture\n" }): Promise<TempRepo> {
  const path = await realpath(await mkdtemp(join(tmpdir(), "seance-runner-repo-")));
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await rm(path, { recursive: true, force: true });
  };
  try {
    await git(path, ["init", "--quiet", "--initial-branch=main"]);
    for (const [name, content] of Object.entries(files)) {
      await mkdir(dirname(join(path, name)), { recursive: true });
      await writeFile(join(path, name), content, "utf8");
    }
    await git(path, ["add", "-A"]);
    await git(path, [
      "-c", "user.name=Seance Test",
      "-c", "user.email=test@example.invalid",
      "-c", "commit.gpgsign=false",
      "commit", "--quiet", "-m", "initial",
    ]);
  } catch (err) {
    await dispose();
    throw err;
  }
  return { path, dispose };
}

/** Runs `fn` with a fresh repo; the repo is removed even when `fn` throws. */
export async function withTempRepo<T>(fn: (repo: TempRepo) => Promise<T>): Promise<T> {
  const repo = await createTempRepo();
  try {
    return await fn(repo);
  } finally {
    await repo.dispose();
  }
}
