// agent-sandbox Requirement 2: a public server refuses to run agents outside the podman sandbox.
// Pure: reads only the given environment; `main` calls it before any listener is opened.
import { assertSandboxForPublic } from "@seance/runner";

/** Thrown for an `IRCD_PUBLIC` value other than unset, empty, `0` or `1` (Requirement 2.1). */
export class PublicConfigError extends Error {
  constructor(raw: string) {
    super(`IRCD_PUBLIC must be unset, empty, "0" or "1" (got ${JSON.stringify(raw)})`);
    this.name = "PublicConfigError";
  }
}

/** `IRCD_PUBLIC=1` means a publicly exposed deployment. */
export function parsePublic(raw: string | undefined): boolean {
  if (raw === undefined || raw === "" || raw === "0") return false;
  if (raw === "1") return true;
  throw new PublicConfigError(raw);
}

/**
 * The startup check (Requirement 2.1 to 2.3): returns whether the deployment is public, or throws
 * a message naming `IRCD_PUBLIC` and `SEANCE_SANDBOX` when agents would run unsandboxed.
 */
export function checkPublicStartup(env: Readonly<Record<string, string | undefined>>): { readonly publicDeployment: boolean } {
  const publicDeployment = parsePublic(env["IRCD_PUBLIC"]);
  assertSandboxForPublic({
    public: publicDeployment,
    runnerEnabled: env["SEANCE_RUNNER"] === "1",
    sandbox: env["SEANCE_SANDBOX"] === "podman" ? "podman" : "none",
  });
  return { publicDeployment };
}
