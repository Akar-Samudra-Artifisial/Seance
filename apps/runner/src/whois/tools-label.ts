/** Where the agent's shell runs: on the host (`none`) or inside the Podman sandbox (`podman`). */
export type ToolsSandboxMode = "none" | "podman";

/**
 * A well-formed token only: `shell(<no parentheses>)`, or a bare `shell` not followed by a word
 * character or `(`. A malformed `shell(x` therefore matches nothing and is left as it is.
 */
const SHELL_TOKEN = /\bshell(?:\([^()]*\)|(?![\w(]))/;

/**
 * The WHOIS `tools:` text for an agent. The profile names a shell tool, but where that shell runs
 * depends on the runner's sandbox mode, so the `shell(...)` token is rewritten to `shell(host)` or
 * `shell(sandbox)`. Text without a shell token is returned unchanged. Pure.
 */
export function toolsLabel(raw: string, mode: ToolsSandboxMode): string {
  const where = mode === "podman" ? "sandbox" : "host";
  return raw.replace(SHELL_TOKEN, `shell(${where})`);
}
