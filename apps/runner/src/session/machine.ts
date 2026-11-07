/**
 * Pure Session state machine (Requirement 6, design "Session state machine").
 * No timers, no I/O: `transition` returns the next model and the effects the
 * caller must run.
 */

export type SessionState = "idle" | "prompting" | "cancelling" | "cooldown" | "closed";

export type Prompt = { readonly id: number; readonly text: string };

export type SessionModel = {
  readonly state: SessionState;
  /** Waiting prompts, oldest first. Bound: QUEUE_BOUND. */
  readonly queue: readonly Prompt[];
  readonly inFlight: Prompt | undefined;
  /** Exorcism started: refuse new prompts and never drain. */
  readonly closing: boolean;
};

export type TurnOutcome = "end_turn" | "cancelled" | "other" | { readonly error: string };

export type MachineEvent =
  | { readonly kind: "enqueue"; readonly prompt: Prompt }
  | { readonly kind: "cancel" }
  | { readonly kind: "turn-ended"; readonly outcome: TurnOutcome }
  | { readonly kind: "cooldown-elapsed" }
  | { readonly kind: "begin-closing" }
  | { readonly kind: "close"; readonly reason: "exorcism" | "process-exit" | "shutdown" };

export type DropReason = "overflow" | "closed" | "closing" | "credit-blocked";

export type Effect =
  | { readonly kind: "send-prompt"; readonly prompt: Prompt }
  | { readonly kind: "send-cancel" }
  | { readonly kind: "start-cooldown" }
  | { readonly kind: "stop-cooldown" }
  | { readonly kind: "drop"; readonly prompt: Prompt; readonly why: DropReason }
  | { readonly kind: "notify-ops"; readonly text: string };

export type TransitionResult = {
  readonly model: SessionModel;
  readonly effects: readonly Effect[];
};

export const QUEUE_BOUND = 20;
export const COOLDOWN_MS = 1000;

/** A fresh Session model (also used for a Session that replaces a closed one, Req 6.13). */
export function initialModel(): SessionModel {
  return { state: "idle", queue: [], inFlight: undefined, closing: false };
}

function unchanged(model: SessionModel): TransitionResult {
  return { model, effects: [] };
}

/** Move the oldest queued prompt in flight, or go idle when the queue is empty. */
function drain(model: SessionModel, effects: readonly Effect[]): TransitionResult {
  const [oldest, ...rest] = model.queue;
  if (oldest === undefined) {
    return { model: { ...model, state: "idle", queue: [], inFlight: undefined }, effects };
  }
  return {
    model: { ...model, state: "prompting", queue: rest, inFlight: oldest },
    effects: [...effects, { kind: "send-prompt", prompt: oldest }],
  };
}

function dropQueue(queue: readonly Prompt[], why: DropReason): readonly Effect[] {
  return queue.map((prompt): Effect => ({ kind: "drop", prompt, why }));
}

function describeDrop(prompt: Prompt): string {
  return `queue full, dropped oldest prompt #${prompt.id}: ${prompt.text}`;
}

function describeFailure(outcome: TurnOutcome): string {
  if (typeof outcome === "object") return `prompt failed: ${outcome.error}`;
  return `prompt ended with stop reason ${outcome}`;
}

function onEnqueue(m: SessionModel, prompt: Prompt): TransitionResult {
  if (m.state === "closed") {
    return { model: m, effects: [{ kind: "drop", prompt, why: "closed" }] };
  }
  if (m.closing) {
    return { model: m, effects: [{ kind: "drop", prompt, why: "closing" }] };
  }
  if (m.state === "idle") {
    // Idle with an empty queue sends at once; a non-empty queue is appended, then drained.
    return drain({ ...m, queue: [...m.queue, prompt] }, []);
  }
  // prompting, cancelling, cooldown: queue only.
  if (m.queue.length >= QUEUE_BOUND) {
    const [oldest, ...rest] = m.queue;
    if (oldest !== undefined) {
      return {
        model: { ...m, queue: [...rest, prompt] },
        effects: [
          { kind: "drop", prompt: oldest, why: "overflow" },
          { kind: "notify-ops", text: describeDrop(oldest) },
        ],
      };
    }
  }
  return { model: { ...m, queue: [...m.queue, prompt] }, effects: [] };
}

function onTurnEnded(m: SessionModel, outcome: TurnOutcome): TransitionResult {
  if (m.state === "prompting") {
    if (outcome === "cancelled") {
      // Agent-side abort without our cancel: cooldown protects the next prompt.
      return {
        model: { ...m, state: "cooldown", inFlight: undefined },
        effects: [{ kind: "start-cooldown" }],
      };
    }
    const notice: readonly Effect[] =
      outcome === "end_turn" ? [] : [{ kind: "notify-ops", text: describeFailure(outcome) }];
    const next: SessionModel = { ...m, inFlight: undefined };
    if (m.closing) {
      return { model: { ...next, state: "idle" }, effects: notice };
    }
    return drain(next, notice);
  }
  if (m.state === "cancelling") {
    return {
      model: { ...m, state: "cooldown", inFlight: undefined },
      effects: [{ kind: "start-cooldown" }],
    };
  }
  return unchanged(m);
}

function onCooldownElapsed(m: SessionModel): TransitionResult {
  if (m.state !== "cooldown") return unchanged(m);
  const stop: readonly Effect[] = [{ kind: "stop-cooldown" }];
  if (m.closing) {
    return { model: { ...m, state: "idle" }, effects: stop };
  }
  return drain(m, stop);
}

function onBeginClosing(m: SessionModel): TransitionResult {
  if (m.state === "closed") return unchanged(m);
  return {
    model: { ...m, closing: true, queue: [] },
    effects: dropQueue(m.queue, "closing"),
  };
}

function onClose(m: SessionModel): TransitionResult {
  if (m.state === "closed") return unchanged(m);
  const stop: readonly Effect[] =
    m.state === "cooldown" || m.state === "prompting" ? [{ kind: "stop-cooldown" }] : [];
  return {
    model: { state: "closed", queue: [], inFlight: undefined, closing: m.closing },
    effects: [...dropQueue(m.queue, "closed"), ...stop],
  };
}

/** Pure reducer. Never mutates `m` or `e`. */
export function transition(m: SessionModel, e: MachineEvent): TransitionResult {
  switch (e.kind) {
    case "enqueue":
      return onEnqueue(m, e.prompt);
    case "cancel":
      if (m.state !== "prompting") return unchanged(m);
      return { model: { ...m, state: "cancelling" }, effects: [{ kind: "send-cancel" }] };
    case "turn-ended":
      return onTurnEnded(m, e.outcome);
    case "cooldown-elapsed":
      return onCooldownElapsed(m);
    case "begin-closing":
      return onBeginClosing(m);
    case "close":
      return onClose(m);
  }
}
