import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  initialModel,
  QUEUE_BOUND,
  transition,
  type MachineEvent,
  type Prompt,
  type SessionModel,
  type TurnOutcome,
} from "../src/session/machine.js";

/**
 * P1: session state-machine safety.
 * **Validates: Requirements 6.14, 6.3, 6.6, 6.7**
 */
const TAG =
  "Feature: agent-runner, Property 1: at most one in-flight prompt, cancel only while prompting, no prompt during cancelling or cooldown";
const RUNS = { numRuns: 200 } as const;

// ---------- generators ----------

// Multi-byte text: byte length differs from string length.
const textArb = fc.oneof(
  fc.string({ maxLength: 12 }),
  fc.constantFrom("日本語", "👻🕯️", "e\u0301", "plain"),
);

const promptArb = (id: number): fc.Arbitrary<Prompt> =>
  textArb.map((text): Prompt => ({ id, text }));

const turnOutcomeArb: fc.Arbitrary<TurnOutcome> = fc.oneof(
  fc.constant<TurnOutcome>("end_turn"),
  fc.constant<TurnOutcome>("cancelled"),
  fc.constant<TurnOutcome>("other"),
  fc.string({ maxLength: 8 }).map((error): TurnOutcome => ({ error })),
);

// Event kinds without ids; enqueue gets its id from the position in the sequence.
type RawEvent =
  | { readonly kind: "enqueue"; readonly text: string }
  | Exclude<MachineEvent, { readonly kind: "enqueue" }>;

const rawEventArb: fc.Arbitrary<RawEvent> = fc.oneof(
  { arbitrary: textArb.map((text): RawEvent => ({ kind: "enqueue", text })), weight: 4 },
  { arbitrary: fc.constant<RawEvent>({ kind: "cancel" }), weight: 2 },
  {
    arbitrary: turnOutcomeArb.map((outcome): RawEvent => ({ kind: "turn-ended", outcome })),
    weight: 3,
  },
  { arbitrary: fc.constant<RawEvent>({ kind: "cooldown-elapsed" }), weight: 2 },
  { arbitrary: fc.constant<RawEvent>({ kind: "begin-closing" }), weight: 1 },
  {
    arbitrary: fc
      .constantFrom("exorcism", "process-exit", "shutdown" as const)
      .map((reason): RawEvent => ({ kind: "close", reason: reason as "exorcism" })),
    weight: 1,
  },
);

const scenarioArb = fc.record({
  initialQueue: fc.array(textArb, { maxLength: QUEUE_BOUND }),
  events: fc.array(rawEventArb, { maxLength: 80 }),
});

// ---------- property ----------

describe("P1 session state-machine safety", () => {
  it(TAG, () => {
    fc.assert(
      fc.property(scenarioArb, ({ initialQueue, events }) => {
        let nextId = 0;
        const queue: readonly Prompt[] = initialQueue.map((text) => ({ id: nextId++, text }));
        let model: SessionModel = { ...initialModel(), queue };

        let sent = 0;
        let ended = 0;
        let cancelsThisTurn = 0;

        for (const raw of events) {
          const event: MachineEvent =
            raw.kind === "enqueue" ? { kind: "enqueue", prompt: { id: nextId++, text: raw.text } } : raw;
          const prev = model;
          const result = transition(prev, event);
          model = result.model;

          // A turn ends when the in-flight prompt is cleared (count before new sends).
          // A drain replaces the in-flight prompt in the same step, so a send-prompt also counts.
          const sentNow = result.effects.some((e) => e.kind === "send-prompt");
          if (prev.inFlight !== undefined && (model.inFlight === undefined || sentNow)) ended += 1;

          for (const effect of result.effects) {
            if (effect.kind === "send-prompt") {
              sent += 1;
              cancelsThisTurn = 0;
              // (c) never while cancelling or cooldown. A prompt leaves cooldown only on
              // cooldown-elapsed (Req 6.9), and the model is then prompting.
              expect(prev.state).not.toBe("cancelling");
              expect(model.state).toBe("prompting");
              if (prev.state === "cooldown") expect(event.kind).toBe("cooldown-elapsed");
              expect(model.closing).toBe(false);
            }
            if (effect.kind === "send-cancel") {
              // (b) only from prompting, at most once per turn
              expect(prev.state).toBe("prompting");
              cancelsThisTurn += 1;
              expect(cancelsThisTurn).toBeLessThanOrEqual(1);
            }
          }

          // (a) at most one prompt sent and not yet ended
          expect(sent - ended).toBeLessThanOrEqual(1);
          expect(sent - ended).toBe(model.inFlight === undefined ? 0 : 1);

          // (d) bounded queue; in-flight iff prompting or cancelling
          expect(model.queue.length).toBeLessThanOrEqual(QUEUE_BOUND);
          expect(model.state === "prompting" || model.state === "cancelling").toBe(
            model.inFlight !== undefined,
          );
        }
      }),
      RUNS,
    );
  });

  it("ignores cancel when nothing is in flight (Req 6.7)", () => {
    const result = transition(initialModel(), { kind: "cancel" });
    expect(result.effects).toEqual([]);
    expect(result.model).toEqual(initialModel());
  });
});
