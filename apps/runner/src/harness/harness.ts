import type { MeteringEntry } from "../credits/accumulator.js";
import type { Unsubscribe } from "../ports.js";
import type { AgentProfile } from "../registry/agent-profile.js";

/** `end_turn` and `cancelled` are known; other ACP values pass through. */
export type StopReason = "end_turn" | "cancelled" | (string & {});

export type TurnResult = { readonly stopReason: StopReason };

/** Untrusted description of a tool call, as received from the agent. */
export type ToolInfo = {
  readonly kind: string;
  readonly title: string;
  readonly paths: readonly string[];
  readonly command?: string;
};

export type SessionEvent =
  | { readonly kind: "message-chunk"; readonly text: string }
  | { readonly kind: "thought-chunk"; readonly text: string }
  | { readonly kind: "tool-call"; readonly tool: ToolInfo }
  /** A tool call finished (`tool_call_update` with status `completed` or `failed`). */
  | { readonly kind: "tool-done"; readonly status: "completed" | "failed" }
  | {
      readonly kind: "metadata";
      readonly turnDurationMs?: number;
      readonly metering: readonly MeteringEntry[];
    }
  | { readonly kind: "unknown"; readonly sessionUpdate: string };

export type PermissionRequest = {
  readonly tool: ToolInfo;
  readonly options: readonly { readonly id: string; readonly kind: string }[];
};

export type PermissionAnswer =
  | { readonly decision: "allow_once" | "reject_once" }
  | { readonly cancelled: true };

export type PermissionHandler = (req: PermissionRequest) => Promise<PermissionAnswer>;

export interface HarnessSession {
  readonly id: string;
  /** Rejects when the process exits or hangs. */
  prompt(text: string): Promise<TurnResult>;
  /** Sends one `session/cancel` notification. */
  cancel(): void;
  /** Forgets the session locally; no wire call is verified for Kiro. */
  close(): Promise<void>;
  onEvent(listener: (e: SessionEvent) => void): Unsubscribe;
}

export type ProcessEvent =
  | { readonly kind: "hung"; readonly agent: string; readonly sessionIds: readonly string[] }
  | {
      readonly kind: "exited";
      readonly agent: string;
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      /**
       * Podman mode (agent-sandbox Requirement 8.3): the sessions of the one container that exited.
       * Absent when the process served every session of the agent (`none` mode).
       */
      readonly sessionIds?: readonly string[];
    };

export interface AgentHarness {
  openSession(
    profile: AgentProfile,
    opts: { readonly cwd: string; readonly onPermission: PermissionHandler },
  ): Promise<HarnessSession>;
  /** Process-level stop. */
  terminate(profile: AgentProfile, signal?: "SIGTERM" | "SIGKILL"): Promise<void>;
  /** Emits "hung" and "exited". */
  onProcessEvent(listener: (e: ProcessEvent) => void): Unsubscribe;
  hasProcess(profile: AgentProfile): boolean;
  /** Terminates every process (shutdown). */
  dispose(): Promise<void>;
}
