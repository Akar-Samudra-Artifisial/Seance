import type { TimerHandle, TimerSet } from "../clock.js";
import type { HarnessSession, SessionEvent } from "../harness/harness.js";
import type { RunnerLogger } from "../log.js";
import type { Unsubscribe } from "../ports.js";
import type { WhoisSnapshot } from "../whois/snapshot.js";
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
  readonly #unsubscribe: Unsubscribe;
  #model: SessionModel = initialModel();
  #cooldownTimer: TimerHandle | undefined;
  /** Id of a prompt whose gate check is pending (no `session/prompt` sent yet). */
  #gating: number | undefined;
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

  /** Runs `hook` synchronously before each `turn-ended` is posted. */
  turnEnding(hook: TurnEndingHook): Unsubscribe {
    this.#turnEnding.add(hook);
    return () => {
      this.#turnEnding.delete(hook);
    };
  }

  enqueue(prompt: Prompt): void {
    if (this.#deps.isBlocked(this.channel)) {
      this.#deps.sink.dropped(prompt, "credit-blocked");
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

  close(reason: "exorcism" | "process-exit" | "shutdown"): void {
    this.#post({ kind: "close", reason });
    this.#unsubscribe();
  }

  #post(event: MachineEvent): void {
    const result = transition(this.#model, event);
    const stateChanged = result.model.state !== this.#model.state;
    this.#model = result.model;
    if (stateChanged) {
      this.#deps.snapshot.setState(this.agent, this.channel, result.model.state);
    }
    for (const effect of result.effects) this.#run(effect);
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
