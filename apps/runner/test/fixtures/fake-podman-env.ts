// Per-test fake podman: a wrapper script that pins the log, state and mode of fake-podman.mjs.
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = dirname(fileURLToPath(import.meta.url));
export const FAKE_PODMAN_BIN = resolve(FIXTURES, "fake-podman");

export type PodmanCall = { readonly args: readonly string[]; readonly envNames: readonly string[] };

export interface FakePodman {
  /** Path of the wrapper to use as SEANCE_PODMAN_BIN. */
  readonly bin: string;
  /** Every call so far, in order. */
  calls(): Promise<readonly PodmanCall[]>;
  /** Names of containers whose run process is still alive (state files). */
  live(): Promise<readonly string[]>;
  /** Replaces the mode switches for the following calls. */
  setMode(mode: readonly string[]): Promise<void>;
  dispose(): Promise<void>;
}

const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export async function createFakePodman(mode: readonly string[] = []): Promise<FakePodman> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "seance-fake-podman-")));
  const bin = join(dir, "podman");
  const logFile = join(dir, "calls.jsonl");
  const state = join(dir, "state");
  const modeFile = join(dir, "mode");
  await mkdir(state, { recursive: true });
  await writeFile(logFile, "");
  const writeMode = async (m: readonly string[]): Promise<void> => {
    await writeFile(modeFile, m.join(","));
  };
  await writeMode(mode);
  await writeFile(
    bin,
    [
      "#!/bin/sh",
      `FAKE_PODMAN_LOG=${shQuote(logFile)}`,
      `FAKE_PODMAN_STATE=${shQuote(state)}`,
      `FAKE_PODMAN_MODE=$(cat ${shQuote(modeFile)})`,
      "export FAKE_PODMAN_LOG FAKE_PODMAN_STATE FAKE_PODMAN_MODE",
      `exec node ${shQuote(join(FIXTURES, "fake-podman.mjs"))} "$@"`,
      "",
    ].join("\n"),
  );
  await chmod(bin, 0o755);
  return {
    bin,
    async calls() {
      const text = await readFile(logFile, "utf8");
      return text
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as PodmanCall);
    },
    async live() {
      return (await readdir(state)).sort();
    },
    setMode: writeMode,
    async dispose() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
