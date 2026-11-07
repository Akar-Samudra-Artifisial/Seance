import { allowListedEnv } from "../child-env.js";
import type { RunnerConfig } from "../config.js";
import type { AgentProfile } from "../registry/agent-profile.js";

export type SpawnSpec = {
  readonly command: string;
  readonly args: readonly string[];
  /** Process cwd: the agents directory. The worktree goes only to `session/new`. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
};

/**
 * Builds the `kiro-cli acp` launch spec. `KIRO_API_KEY` is placed in the child
 * environment only when set and non-empty, never in `args`. `--trust-all-tools`
 * is never built.
 */
export function buildSpawnSpec(
  profile: Pick<AgentProfile, "kiroAgent">,
  config: Pick<RunnerConfig, "kiroBin" | "kiroApiKey" | "agentsDir">,
  baseEnv: Readonly<Record<string, string | undefined>> = process.env,
  extraEnv: Readonly<Record<string, string | undefined>> = {},
): SpawnSpec {
  // Allow-list, never a spread of the runner's environment; `extraEnv` is explicit (test launchers).
  const env: Record<string, string | undefined> = { ...allowListedEnv(baseEnv), ...extraEnv };
  if (config.kiroApiKey !== undefined && config.kiroApiKey !== "") {
    env["KIRO_API_KEY"] = config.kiroApiKey;
  }
  return {
    command: config.kiroBin,
    args: ["acp", "--agent", profile.kiroAgent],
    cwd: config.agentsDir,
    env,
  };
}
