import { allowListedEnv } from "../child-env.js";
import type { RunnerConfig } from "../config.js";
import type { AgentProfile } from "../registry/agent-profile.js";
import type { PodmanLauncher, SandboxSpec } from "../sandbox/launcher.js";

export type SpawnSpec = {
  readonly command: string;
  readonly args: readonly string[];
  /** Process cwd: the agents directory. The worktree goes only to `session/new`. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
};

/**
 * Podman mode (agent-sandbox design "Spawn and harness"): a thin call to the launcher. The command
 * is the podman binary and the image runs `acp --agent <name>`. When set, `KIRO_API_KEY` is forwarded
 * name-only (`-e KIRO_API_KEY`); its value is in the podman process environment, never in argv
 * (sandbox-api-key-auth).
 */
export function buildSandboxSpawnSpec(
  launcher: Pick<PodmanLauncher, "spec">,
  profile: Pick<AgentProfile, "nick" | "kiroAgent">,
  sessionCwd: string,
  extraEnv: Readonly<Record<string, string | undefined>> = {},
): Promise<SandboxSpec> {
  return launcher.spec({ nick: profile.nick, kiroAgent: profile.kiroAgent, sessionCwd, extraEnv });
}

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
