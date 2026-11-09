import type { TimerHandle, TimerSet } from "../clock.js";
import type { HarnessSession, SessionEvent } from "../harness/harness.js";
import type { RunnerLogger } from "../log.js";
import type { Unsubscribe } from "../ports.js";
import type { WhoisSnapshot } from "../whois/snapshot.js";
import type { PendingPermissions } from "./pending-permissions.js";
import {
  COOLDOWN_MS,
  initialModel,
  transition,
  type DropReason,
  type Effect,
  type MachineEvent,
  type Prompt,
  type SessionModel,
  type SessionState,
  type TurnOutcome,
} from "./machine.js";

/** Reasons a prompt is reported dropped: the machine's, plus the worktree prompt gate's. */
export type SinkDropReason = DropReason | "config-present";

/** Receives dropped prompts; logs, and for `overflow` produces the Req 6.10 notice. */
export interface PromptSink {
  dropped(prompt: Prompt, why: SinkDropReason): void;
}

export type PromptGateResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly paths: readonly string[] };

/** Worktree prompt gate (Req 4.14); wired to `WorktreeManager.guardBeforePrompt`. */
export interface PromptGate {
  check(): Promise<PromptGateResult>;
}

/** Hook run just before a `turn-ended` event is posted (flush output, clear AWAY). */
export type TurnEndingHook = (outcome: TurnOutcome) => void;

export type SessionDeps = {
  /** Agent nick, display spelling. */
  readonly agent: string;
  /** Channel name, display spelling. */
  readonly channel: string;
  readonly harnessSession: HarnessSession;
  readonly snapshot: WhoisSnapshot;
  readonly timers: TimerSet;
  readonly gate: PromptGate;
  readonly sink: PromptSink;
  /** One NOTICE per Human_Op of the channel. */
  readonly opNotice: (channel: string, text: string) => void;
  /** Credit-blocked check for the channel (Req 10.10). */
  readonly isBlocked: (channel: string) => boolean;
  readonly logger?: RunnerLogger;
  /**
   * agent-sandbox Requirement 14: runs after a turn that ended `end_turn` while the Session was not
   * closing, before `turn-ended` is posted, so the next prompt waits for it. Must not reject.
   */
  readonly afterTurn?: () => Promise<void>;
  /**
   * agent-runner Requirement 9.18: `onIdle` runs once the Session has been idle (no prompt in
   * flight, empty queue, no pending permission) and without activity for `timeoutS` seconds.
   * The timer uses `timers`, never the wall clock. Absent means no idle timeout.
   */
  readonly idle?: {
    readonly timeoutS: number;
    readonly onIdle: () => void;
    readonly permissions?: PendingPermissions;
  };
};

const MAX_NOTICE_BYTES = 512;

/** Truncates to at most `max` UTF-8 bytes without splitting a code point. */
function clampBytes(text: string, max: number): string {
  if (Buffer.byteLength(text, "utf8") <= max) return text;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch, "utf8");
    if (used + n > max) break;
    out += ch;
    used += n;
  }
  return out;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Effects runner around the pure reducer (design "Session state machine").
 * One instance per (agent, channel). Every state change reaches the
 * WhoisSnapshot synchronously (Req 10.17).
 */
export class Session {
  readonly agent: string;
  readonly channel: string;
  readonly #deps: SessionDeps;
  readonly #listeners = new Set<(e: SessionEvent) => void>();
  readonly #turnEnding = new Set<TurnEndingHook>();
  readonly #stateListeners = new Set<(state: SessionState) => void>();
  readonly #unsubscribe: Unsubscribe;
  #model: SessionModel = initialModel();
  #cooldownTimer: TimerHandle | undefined;
  #idleTimer: TimerHandle | undefined;
  #offPermissions: Unsubscribe | undefined;
  /** Id of a prompt whose gate check is pending (no `session/prompt` sent yet). */
  #gating: number | undefined;
  /** True while `afterTurn` runs: the turn is over, so a cancel must not reach the wire. */
  #afterTurnRunning = false;
  #cancelDuringGate = false;
  #suppressNotify = false;

  constructor(deps: SessionDeps) {
    this.agent = deps.agent;
    this.channel = deps.channel;
    this.#deps = deps;
    deps.snapshot.setState(deps.agent, deps.channel, this.#model.state);
    this.#unsubscribe = deps.harnessSession.onEvent((e) => {
      this.#onHarnessEvent(e);
    });
    this.#offPermissions = deps.idle?.permissions?.onChange(() => {
      this.#syncIdle();
    });
    this.#syncIdle();
  }

  get state(): SessionState {
    return this.#model.state;
  }

  get model(): SessionModel {
    return this.#model;
  }

  get acpSessionId(): string {
    return this.#deps.harnessSession.id;
  }

  /** Streaming attach point (task 11.3): every harness event of this session. */
  sessionEvents(listener: (e: SessionEvent) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Called synchronously with each new state (public-hardening: private sessions leave the count when closed). */
  stateChanges(listener: (state: SessionState) => void): Unsubscribe {
    this.#stateListeners.add(listener);
    return () => {
      this.#stateListeners.delete(listener);
    };
  }

  /** Runs `hook` synchronously before each `turn-ended` is posted. */
  turnEnding(hook: TurnEndingHook): Unsubscribe {
    this.#turnEnding.add(hook);
    return () => {
      this.#turnEnding.delete(hook);
    };
  }

  enqueue(prompt: Prompt): void {
    if (this.#deps.isBlocked(this.channel)) {
      this.#deps.sink.dropped(prompt, "credit-blocked"); // a dropped prompt is not activity
      return;
    }
    this.#post({ kind: "enqueue", prompt });
  }

  cancel(): void {
    this.#post({ kind: "cancel" });
  }

  beginClosing(): void {
    this.#post({ kind: "begin-closing" });
  }

  close(reason: "exorcism" | "process-exit" | "shutdown" | "idle"): void {
    this.#post({ kind: "close", reason });
    this.#unsubscribe();
    this.#offPermissions?.();
    this.#offPermissions = undefined;
  }

  /**
   * (Re)starts the idle countdown when the Session is idle, has nothing queued, no pending
   * permission and is not closing; otherwise clears it. Called after every state change and
   * every activity, so activity always restarts the full timeout (Requirement 9.18).
   */
  #syncIdle(): void {
    const idle = this.#deps.idle;
    if (idle === undefined) return;
    if (this.#idleTimer !== undefined) {
      this.#deps.timers.clear(this.#idleTimer);
      this.#idleTimer = undefined;
    }
    if (!this.#isQuiet()) return;
    this.#idleTimer = this.#deps.timers.set(() => {
      this.#idleTimer = undefined;
      if (!this.#isQuiet()) return;
      try {
        idle.onIdle();
      } catch (err) {
        this.#deps.logger?.error("idle handler failed", { agent: this.agent, channel: this.channel, reason: messageOf(err) });
      }
    }, idle.timeoutS * 1000);
  }

  #isQuiet(): boolean {
    const m = this.#model;
    return (
      m.state === "idle" &&
      m.queue.length === 0 &&
      m.inFlight === undefined &&
      !m.closing &&
      (this.#deps.idle?.permissions?.count ?? 0) === 0
    );
  }

  #post(event: MachineEvent): void {
    const before = this.#model;
    const result = transition(before, event);
    const stateChanged = result.model.state !== this.#model.state;
    this.#model = result.model;
    if (stateChanged) {
      this.#deps.snapshot.setState(this.agent, this.channel, result.model.state);
      for (const listener of [...this.#stateListeners]) {
        try {
          listener(result.model.state);
        } catch (err) {
          this.#deps.logger?.error("state listener failed", { agent: this.agent, channel: this.channel, reason: messageOf(err) });
        }
      }
    }
    for (const effect of result.effects) this.#run(effect);
    // The reducer returns the same model for a no-op event (a cancel while idle, a prompt refused
    // by a closing or closed session); that is not activity.
    if (result.model !== before) this.#syncIdle();
  }

  #run(effect: Effect): void {
    switch (effect.kind) {
      case "send-prompt":
        void this.#sendPrompt(effect.prompt);
        return;
      case "send-cancel":
        if (this.#gating !== undefined) {
          // No session/prompt was sent yet; a cancel now would poison the next turn.
          this.#cancelDuringGate = true;
          return;
        }
        // The turn already ended; only the host-side commit runs (agent-sandbox Requirement 14.5).
        if (this.#afterTurnRunning) return;
        this.#deps.harnessSession.cancel();
        return;
      case "start-cooldown":
        this.#clearCooldown();
        this.#cooldownTimer = this.#deps.timers.set(() => {
          this.#cooldownTimer = undefined;
          this.#post({ kind: "cooldown-elapsed" });
        }, COOLDOWN_MS);
        return;
      case "stop-cooldown":
        this.#clearCooldown();
        return;
      case "drop":
        this.#deps.sink.dropped(effect.prompt, effect.why);
        return;
      case "notify-ops":
        if (this.#suppressNotify) return;
        this.#deps.opNotice(this.channel, `${this.agent}: ${effect.text}`);
        return;
    }
  }

  #clearCooldown(): void {
    if (this.#cooldownTimer === undefined) return;
    this.#deps.timers.clear(this.#cooldownTimer);
    this.#cooldownTimer = undefined;
  }

  async #sendPrompt(prompt: Prompt): Promise<void> {
    this.#gating = prompt.id;
    this.#cancelDuringGate = false;
    let verdict: PromptGateResult;
    try {
      verdict = await this.#deps.gate.check();
    } catch (err) {
      this.#gating = undefined;
      this.#deps.logger?.error("prompt gate failed", {
        agent: this.agent,
        channel: this.channel,
        reason: messageOf(err),
      });
      if (this.#model.inFlight?.id === prompt.id) {
        this.#finish({ error: `prompt gate failed: ${messageOf(err)}` });
      }
      return;
    }
    const cancelled = this.#cancelDuringGate;
    this.#gating = undefined;
    this.#cancelDuringGate = false;
    if (this.#model.inFlight?.id !== prompt.id) return; // closed while checking

    if (!verdict.ok) {
      this.#deps.sink.dropped(prompt, "config-present");
      const text = clampBytes(
        `${this.agent}: prompt dropped, protected config present in the worktree: ${verdict.paths.join(", ")}`,
        MAX_NOTICE_BYTES,
      );
      this.#deps.opNotice(this.channel, text);
      this.#suppressNotify = true;
      try {
        this.#finish({ error: "config-present" });
      } finally {
        this.#suppressNotify = false;
      }
      return;
    }
    if (cancelled) {
      this.#finish("cancelled");
      return;
    }

    let outcome: TurnOutcome;
    try {
      const result = await this.#deps.harnessSession.prompt(prompt.text);
      outcome =
        result.stopReason === "end_turn"
          ? "end_turn"
          : result.stopReason === "cancelled"
            ? "cancelled"
            : "other";
    } catch (err) {
      outcome = { error: messageOf(err) };
    }
    if (this.#model.inFlight?.id !== prompt.id) return; // closed meanwhile
    const afterTurn = this.#deps.afterTurn;
    if (afterTurn !== undefined && outcome === "end_turn" && this.#model.state === "prompting" && !this.#model.closing) {
      this.#afterTurnRunning = true;
      try {
        await afterTurn();
      } catch (err) {
        this.#deps.logger?.error("afterTurn hook failed", { agent: this.agent, channel: this.channel, reason: messageOf(err) });
      } finally {
        this.#afterTurnRunning = false;
      }
      if (this.#model.inFlight?.id !== prompt.id) return; // closed meanwhile
    }
    this.#finish(outcome);
  }

  #finish(outcome: TurnOutcome): void {
    for (const hook of [...this.#turnEnding]) {
      try {
        hook(outcome);
      } catch (err) {
        this.#deps.logger?.error("turnEnding hook failed", {
          agent: this.agent,
          channel: this.channel,
          reason: messageOf(err),
        });
      }
    }
    this.#post({ kind: "turn-ended", outcome });
  }

  #onHarnessEvent(e: SessionEvent): void {
    // A streamed event is activity only while a prompt is in flight; one that arrives while the
    // session is idle must not restart the countdown (Requirement 9.18).
    const s = this.#model.state;
    if (s === "prompting" || s === "cancelling" || s === "cooldown") this.#syncIdle();
    if (e.kind === "metadata" && e.turnDurationMs !== undefined && this.#model.state === "cooldown") {
      this.#post({ kind: "cooldown-elapsed" });
    }
    for (const listener of [...this.#listeners]) {
      try {
        listener(e);
      } catch (err) {
        this.#deps.logger?.error("session event listener failed", {
          agent: this.agent,
          channel: this.channel,
          reason: messageOf(err),
        });
      }
    }
  }
}
