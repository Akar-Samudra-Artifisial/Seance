import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRegistry } from "./agent-registry.js";

/**
 * A profile names a Kiro agent whose definition file is not present where
 * `kiro-cli acp --agent` resolves it. Kiro would silently fall back to the
 * default agent (S8), so the runner must refuse to start.
 */
export class AgentFileMissingError extends Error {
  readonly profileFile: string;
  readonly kiroAgent: string;
  readonly expectedPath: string;

  constructor(profileFile: string, kiroAgent: string, expectedPath: string, detail?: string) {
    super(
      `Agent profile ${profileFile} names Kiro agent "${kiroAgent}" but ${expectedPath} ` +
        `${detail ?? "does not exist"}; kiro-cli would fall back to the default agent`,
    );
    this.name = "AgentFileMissingError";
    this.profileFile = profileFile;
    this.kiroAgent = kiroAgent;
    this.expectedPath = expectedPath;
  }
}

/**
 * Checks `<agentsDir>/.kiro/agents/<kiroAgent>.json` for every profile (must be
 * a regular file). Throws `AgentFileMissingError` for the first failing
 * profile. Spawns nothing.
 */
export const verifyAgentFiles = async (
  registry: AgentRegistry,
  agentsDir: string,
): Promise<void> => {
  for (const profile of registry.all()) {
    const expectedPath = join(agentsDir, ".kiro", "agents", `${profile.kiroAgent}.json`);
    try {
      const info = await stat(expectedPath);
      if (!info.isFile()) {
        throw new AgentFileMissingError(
          profile.file,
          profile.kiroAgent,
          expectedPath,
          "is not a regular file",
        );
      }
    } catch (err) {
      if (err instanceof AgentFileMissingError) throw err;
      const reason = err instanceof Error ? err.message : String(err);
      throw new AgentFileMissingError(
        profile.file,
        profile.kiroAgent,
        expectedPath,
        `cannot be read (${reason})`,
      );
    }
  }
};
