/**
 * `session/request_permission` handler (Requirement 8). The only enforcement
 * point for IRC modes. Fail closed: any malformed input or internal failure
 * answers `cancelled`, never an allow.
 */
import type { PermissionAnswer, PermissionRequest, ToolInfo } from "../harness/harness.js";
import type { RunnerLogger } from "../log.js";
import { truncateBytes } from "../output/agent-output.js";
import type { HostMembership } from "../ports.js";
import { canonicalise, realWorktree } from "./canonicalise.js";
import { classifyKind, decide, isProtectedPath } from "./policy.js";
import type { PermissionReason, PermissionResult, PolicyMode, ResolvedPath } from "./policy.js";

export type PermissionContext = {
  readonly agent: string;
  /** Channel of the Session, for the decision log; absent for a Private_Session. */
  readonly channel?: string;
  /** Realpath-able Worktree, or the private directory for a Private_Session. */
  readonly worktree: string;
  /** Private_Session: voice with the private directory, any write or shell rejected. */
  readonly isPrivate: boolean;
  /** Reads the Agent's mode in the channel NOW (`host.modeOf`); never cached. */
  readonly currentMembership: () => HostMembership | undefined;
  /** Sends one ops NOTICE to the channel; absent for a Private_Session. */
  readonly notifyOps?: (text: string) => void;
  readonly logger: RunnerLogger;
};

/** Leaves room for prefix, target and CRLF inside the 512-byte IRC line. */
const NOTICE_MAX_BYTES = 400;
const LABEL_MAX_BYTES = 80;
const PATH_MAX_BYTES = 120;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const CONTROL = /[\u0000-\u001f\u007f]/g;
const clean = (text: string, max: number): string =>
  truncateBytes(text.replace(CONTROL, " "), max);

type ValidRequest = {
  readonly tool: ToolInfo;
  readonly options: readonly { readonly id: string; readonly kind: string }[];
};

/** Returns the validated request, or the name of the malformed part (no values). */
function validate(req: unknown): ValidRequest | string {
  if (!isRecord(req)) return "request-not-object";
  const tool = req["tool"];
  if (!isRecord(tool)) return "tool-call-missing";
  const options = req["options"];
  if (!Array.isArray(options)) return "options-not-array";
  const { kind, title, paths, command } = tool;
  if (typeof kind !== "string") return "tool-kind-invalid";
  if (typeof title !== "string") return "tool-title-invalid";
  if (!Array.isArray(paths) || !paths.every((p): p is string => typeof p === "string")) {
    return "tool-paths-invalid";
  }
  if (command !== undefined && typeof command !== "string") return "tool-command-invalid";
  const opts: { readonly id: string; readonly kind: string }[] = [];
  for (const o of options as readonly unknown[]) {
    if (!isRecord(o) || typeof o["id"] !== "string" || typeof o["kind"] !== "string") {
      return "option-invalid";
    }
    opts.push({ id: o["id"], kind: o["kind"] });
  }
  const info: ToolInfo =
    command === undefined ? { kind, title, paths } : { kind, title, paths, command };
  return { tool: info, options: opts };
}

const toMode = (m: HostMembership | undefined): PolicyMode =>
  m === undefined ? "none" : m.op ? "op" : m.voice ? "voice" : "none";

export async function handlePermissionRequest(
  ctx: PermissionContext,
  req: PermissionRequest,
): Promise<PermissionAnswer> {
  const cancelled: PermissionAnswer = { cancelled: true };
  try {
    // The mode is read now, before any await.
    const mode: PolicyMode = ctx.isPrivate ? "voice" : toMode(ctx.currentMembership());

    const valid = validate(req);
    if (typeof valid === "string") {
      ctx.logger.warn("permission request malformed; answered cancelled", {
        agent: ctx.agent,
        cause: valid,
      });
      return cancelled;
    }
    const { tool, options } = valid;

    const toolClass = classifyKind(tool.kind);
    let result: PermissionResult;
    let worktree: string | undefined;
    let canonical: readonly ResolvedPath[] = [];
    if (ctx.isPrivate && (toolClass === "write" || toolClass === "shell")) {
      result = { decision: "reject_once", reason: "private-session" };
    } else {
      worktree = await realWorktree(ctx.worktree);
      if (worktree === undefined) {
        result = { decision: "reject_once", reason: "outside-worktree" };
      } else {
        canonical = await canonicalise(tool.paths, worktree);
        result = decide({
          mode,
          tool: tool.command === undefined
            ? { kind: tool.kind, paths: canonical }
            : { kind: tool.kind, paths: canonical, command: tool.command },
          worktree,
        });
      }
    }

    logDecision(ctx, { mode, tool, toolClass, worktree, canonical, result });

    if (result.decision === "reject_once" && result.reason !== "no-mode") {
      notify(ctx, tool, result.reason);
    }

    // First option whose kind equals the decision; `allow_always` is never selected.
    const selected = options.find((o) => o.kind === result.decision);
    if (selected === undefined) {
      ctx.logger.warn("permission option missing; answered cancelled", {
        agent: ctx.agent,
        decision: result.decision,
      });
      return cancelled;
    }
    return { decision: result.decision };
  } catch (err) {
    ctx.logger.error("permission handling failed; answered cancelled", {
      agent: ctx.agent,
      cause: err instanceof Error ? err.name : "unknown",
    });
    return cancelled;
  }
}

/**
 * One info record per decision, so a surprising rejection can be explained from the log alone.
 * Only metadata: kind, title, paths, worktree, decision and reason; never file contents (the
 * request's `rawInput` content fields are not part of ToolInfo and are not logged).
 */
function logDecision(
  ctx: PermissionContext,
  d: {
    readonly mode: PolicyMode;
    readonly tool: ToolInfo;
    readonly toolClass: string;
    readonly worktree: string | undefined;
    readonly canonical: readonly ResolvedPath[];
    readonly result: PermissionResult;
  },
): void {
  ctx.logger.info("permission decision", {
    agent: ctx.agent,
    channel: ctx.channel ?? (ctx.isPrivate ? "(private)" : "(unknown)"),
    mode: d.mode,
    kind: d.tool.kind,
    class: d.toolClass,
    title: clean(d.tool.title, LABEL_MAX_BYTES),
    rawPaths: d.tool.paths.map((p) => clean(p, PATH_MAX_BYTES)),
    canonicalPaths: d.canonical.map((p) => (p.resolved === undefined ? null : clean(p.resolved, PATH_MAX_BYTES))),
    ...(d.tool.command !== undefined ? { command: clean(d.tool.command, LABEL_MAX_BYTES) } : {}),
    worktree: d.worktree ?? null,
    configuredWorktree: ctx.worktree,
    decision: d.result.decision,
    reason: d.result.decision === "reject_once" ? d.result.reason : null,
  });
}

function notify(ctx: PermissionContext, tool: ToolInfo, reason: PermissionReason): void {
  if (ctx.notifyOps === undefined) return;
  const label = clean(tool.title.trim() === "" ? tool.kind : tool.title, LABEL_MAX_BYTES);
  let text = `ops: ${clean(ctx.agent, 64)} denied ${label}: ${reason}`;
  if (reason === "protected-path") {
    const named = tool.paths.find((p) => isProtectedPath(p));
    if (named !== undefined) text += ` (${clean(named, PATH_MAX_BYTES)})`;
  }
  try {
    ctx.notifyOps(truncateBytes(text, NOTICE_MAX_BYTES));
  } catch (err) {
    ctx.logger.error("ops notice failed", {
      agent: ctx.agent,
      cause: err instanceof Error ? err.name : "unknown",
    });
  }
}
