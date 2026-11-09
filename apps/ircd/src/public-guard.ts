// agent-sandbox Requirement 2 and public-hardening Requirement 8: a public server refuses to start
// unless it is locked down. Pure apart from reading the accounts file; `main` calls it before any
// listener is opened.
import { isIP } from "node:net";
import { assertSandboxForPublic, isLoopbackHost } from "@seance/runner";
import { loadAccounts } from "./accounts.js";

/** Thrown for an `IRCD_PUBLIC` value other than unset, empty, `0` or `1` (Requirement 2.1). */
export class PublicConfigError extends Error {
  constructor(raw: string) {
    super(`IRCD_PUBLIC must be unset, empty, "0" or "1" (got ${JSON.stringify(raw)})`);
    this.name = "PublicConfigError";
  }
}

/** public-hardening Requirement 8: every missing protection of a public deployment, named at once. */
export class PublicHardeningError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`IRCD_PUBLIC=1 requires: ${problems.join("; ")}`);
    this.name = "PublicHardeningError";
    this.problems = problems;
  }
}

/** Minimum length of IRCD_SERVER_PASSWORD on a public server. */
export const MIN_PUBLIC_PASSWORD_LENGTH = 20;

/** `IRCD_PUBLIC=1` means a publicly exposed deployment. */
export function parsePublic(raw: string | undefined): boolean {
  if (raw === undefined || raw === "" || raw === "0") return false;
  if (raw === "1") return true;
  throw new PublicConfigError(raw);
}

type Env = Readonly<Record<string, string | undefined>>;

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** True for a loopback IP literal (`127.x.y.z`, `::1`, `::ffff:127.x.y.z`); host names are not accepted. */
export function isLoopbackIp(entry: string): boolean {
  const ip = entry.trim().toLowerCase();
  if (isIP(ip) === 0) return false;
  if (ip === "::1" || ip === "0:0:0:0:0:0:0:1") return true;
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  return isIP(v4) === 4 && v4.startsWith("127.");
}

/** Non-empty, and every entry a loopback IP (the proxy runs on the same host as the ircd). */
export function trustedProxiesOk(raw: string | undefined): boolean {
  const entries = (raw ?? "").split(",").map((e) => e.trim()).filter((e) => e !== "");
  return entries.length > 0 && entries.every(isLoopbackIp);
}

/** The hardening problems of a public deployment; empty means it may start. */
export function publicHardeningProblems(env: Env): readonly string[] {
  const problems: string[] = [];
  const password = env["IRCD_SERVER_PASSWORD"] ?? "";
  if (password.length < MIN_PUBLIC_PASSWORD_LENGTH) {
    problems.push(`IRCD_SERVER_PASSWORD of at least ${MIN_PUBLIC_PASSWORD_LENGTH} characters`);
  }
  const accountsFile = env["IRCD_ACCOUNTS_FILE"] ?? "";
  if (accountsFile.trim() === "") {
    problems.push("IRCD_ACCOUNTS_FILE with at least one account");
  } else {
    try {
      if (loadAccounts(accountsFile).size === 0) problems.push("IRCD_ACCOUNTS_FILE with at least one account (the file is empty)");
    } catch (err) {
      problems.push(`IRCD_ACCOUNTS_FILE readable with at least one account (${messageOf(err)})`);
    }
  }
  const origins = (env["IRCD_WS_ALLOWED_ORIGINS"] ?? "").split(",").map((o) => o.trim()).filter((o) => o !== "");
  if (origins.length === 0 || origins.some((o) => o === "*" || !o.toLowerCase().startsWith("https://"))) {
    problems.push('IRCD_WS_ALLOWED_ORIGINS listing https:// origins only (no "*")');
  }
  if (!isLoopbackHost(env["IRCD_HOST"])) {
    problems.push("IRCD_HOST bound to loopback (TLS is terminated by the proxy)");
  }
  // public-hardening Requirement 11.1: behind the proxy every peer is loopback, so without the
  // proxy list all users share one per-IP connection limit and one PASS-failure block.
  if (!trustedProxiesOk(env["IRCD_TRUSTED_PROXIES"])) {
    problems.push("IRCD_TRUSTED_PROXIES listing the proxy's loopback addresses only (e.g. 127.0.0.1,::1)");
  }
  if (env["SEANCE_RUNNER"] === "1") {
    if ((env["SEANCE_INVITERS"] ?? "").split(",").every((n) => n.trim() === "")) {
      problems.push("SEANCE_INVITERS naming the account nicks that may invite agents");
    }
    if ((env["SEANCE_DAILY_CREDIT_CAP"] ?? "").trim() === "") {
      problems.push("SEANCE_DAILY_CREDIT_CAP (credits per UTC day for all agents)");
    }
  }
  return problems;
}

/**
 * The startup check: returns whether the deployment is public. Throws naming `IRCD_PUBLIC` and
 * `SEANCE_SANDBOX` when agents would run unsandboxed, `SEANCE_SANDBOX_BLOCKED_CIDRS` when a public
 * podman deployment has none (agent-sandbox 2.1 to 2.3), and otherwise a PublicHardeningError
 * naming every missing protection (public-hardening Requirement 8).
 */
export function checkPublicStartup(env: Env): { readonly publicDeployment: boolean } {
  const publicDeployment = parsePublic(env["IRCD_PUBLIC"]);
  // Only counts the entries here; loadRunnerConfig validates them (the runner repeats this check).
  const cidrs = (env["SEANCE_SANDBOX_BLOCKED_CIDRS"] ?? "").split(",").filter((e) => e.trim() !== "").length;
  assertSandboxForPublic({
    public: publicDeployment,
    runnerEnabled: env["SEANCE_RUNNER"] === "1",
    sandbox: env["SEANCE_SANDBOX"] === "podman" ? "podman" : "none",
    blockedCidrs: cidrs,
  });
  if (publicDeployment) {
    const problems = publicHardeningProblems(env);
    if (problems.length > 0) throw new PublicHardeningError(problems);
  }
  return { publicDeployment };
}
