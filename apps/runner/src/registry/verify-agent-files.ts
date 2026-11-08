import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
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
 * agent-skills Req 2.3: a profile names a skill that is not a regular file at
 * `<agentsDir>/.kiro/skills/<name>/SKILL.md`, or whose real path leaves that directory. Skills come
 * only from the repository's agents directory, never from a target repository.
 */
export class AgentSkillMissingError extends Error {
  readonly profileFile: string;
  readonly skill: string;
  readonly expectedPath: string;

  constructor(profileFile: string, skill: string, expectedPath: string, detail: string) {
    super(`Agent profile ${profileFile} names skill "${skill}" but ${expectedPath} ${detail}`);
    this.name = "AgentSkillMissingError";
    this.profileFile = profileFile;
    this.skill = skill;
    this.expectedPath = expectedPath;
  }
}

/** The SKILL.md of every listed skill exists, is a regular file and stays inside `.kiro/skills`. */
const verifySkillFiles = async (registry: AgentRegistry, agentsDir: string): Promise<void> => {
  const skillsRoot = join(agentsDir, ".kiro", "skills");
  let realRoot: string | undefined;
  for (const profile of registry.all()) {
    for (const skill of profile.skills ?? []) {
      const expectedPath = join(skillsRoot, skill, "SKILL.md");
      let real: string;
      try {
        realRoot ??= await realpath(skillsRoot);
        real = await realpath(expectedPath);
        const info = await stat(real);
        if (!info.isFile()) {
          throw new AgentSkillMissingError(profile.file, skill, expectedPath, "is not a regular file");
        }
      } catch (err) {
        if (err instanceof AgentSkillMissingError) throw err;
        const reason = err instanceof Error ? err.message : String(err);
        throw new AgentSkillMissingError(profile.file, skill, expectedPath, `cannot be read (${reason})`);
      }
      // A symlink must not lead a skill out of the agents directory.
      const rel = relative(realRoot, real);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
        throw new AgentSkillMissingError(profile.file, skill, expectedPath, `resolves outside ${skillsRoot}`);
      }
    }
  }
};

/**
 * Checks `<agentsDir>/.kiro/agents/<kiroAgent>.json` for every profile (must be
 * a regular file), then every listed skill. Throws `AgentFileMissingError` or
 * `AgentSkillMissingError` for the first failing profile. Spawns nothing.
 */
export const verifyAgentFiles = async (
  registry: AgentRegistry,
  agentsDir: string,
): Promise<void> => {
  await verifyKiroAgentFiles(registry, agentsDir);
  await verifySkillFiles(registry, agentsDir);
};

const verifyKiroAgentFiles = async (registry: AgentRegistry, agentsDir: string): Promise<void> => {
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
