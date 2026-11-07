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
import type { PermissionReason, PermissionResult, PolicyMode } from "./policy.js";

export type PermissionContext = {
  readonly agent: string;
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
    if (ctx.isPrivate && (toolClass === "write" || toolClass === "shell")) {
      result = { decision: "reject_once", reason: "private-session" };
    } else {
      const worktree = await realWorktree(ctx.worktree);
      if (worktree === undefined) {
        result = { decision: "reject_once", reason: "outside-worktree" };
      } else {
        const paths = await canonicalise(tool.paths, worktree);
        result = decide({
          mode,
          tool: tool.command === undefined
            ? { kind: tool.kind, paths }
            : { kind: tool.kind, paths, command: tool.command },
          worktree,
        });
      }
    }

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
