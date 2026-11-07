import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RunnerLogger } from "../src/log.js";
import { AgentRegistry } from "../src/registry/agent-registry.js";
import { AgentFileMissingError, verifyAgentFiles } from "../src/registry/verify-agent-files.js";

const repoAgents = resolve(dirname(fileURLToPath(import.meta.url)), "../../../agents");

const noop = (): void => undefined;
const log: RunnerLogger = { debug: noop, info: noop, warn: noop, error: noop };

const profileJson = (nick: string): string =>
  JSON.stringify({
    nick,
    kiroAgent: nick,
    model: "claude-haiku-5.5",
    tools: "read",
    color: 3,
  });

/** Creates a temp agents dir with one profile `ghost`, runs `fn`, then removes it. */
const withGhostDir = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "seance-verify-agents-"));
  try {
    await writeFile(join(dir, "ghost.json"), profileJson("ghost"));
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("verifyAgentFiles", () => {
  it("passes for the committed agents/", async () => {
    const registry = await AgentRegistry.load(repoAgents, log);
    await expect(verifyAgentFiles(registry, repoAgents)).resolves.toBeUndefined();
  });

  it("fails naming profile file, agent name and expected path when the agent file is missing", async () => {
    await withGhostDir(async (dir) => {
      const registry = await AgentRegistry.load(dir, log);
      const expectedPath = join(dir, ".kiro", "agents", "ghost.json");

      const err = await verifyAgentFiles(registry, dir).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AgentFileMissingError);
      const missing = err as AgentFileMissingError;
      expect(missing.profileFile).toBe(join(dir, "ghost.json"));
      expect(missing.kiroAgent).toBe("ghost");
      expect(missing.expectedPath).toBe(expectedPath);
      expect(missing.message).toContain(join(dir, "ghost.json"));
      expect(missing.message).toContain('"ghost"');
      expect(missing.message).toContain(expectedPath);
    });
  });

  it("fails when the expected path is a directory instead of a file", async () => {
    await withGhostDir(async (dir) => {
      const expectedPath = join(dir, ".kiro", "agents", "ghost.json");
      await mkdir(expectedPath, { recursive: true });
      const registry = await AgentRegistry.load(dir, log);

      const err = await verifyAgentFiles(registry, dir).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AgentFileMissingError);
      const failure = err as AgentFileMissingError;
      expect(failure.expectedPath).toBe(expectedPath);
      expect(failure.message).toContain("not a regular file");
    });
  });

  it("passes when the agent file is a regular file", async () => {
    await withGhostDir(async (dir) => {
      await mkdir(join(dir, ".kiro", "agents"), { recursive: true });
      await writeFile(join(dir, ".kiro", "agents", "ghost.json"), "{}");
      const registry = await AgentRegistry.load(dir, log);
      await expect(verifyAgentFiles(registry, dir)).resolves.toBeUndefined();
    });
  });
});
