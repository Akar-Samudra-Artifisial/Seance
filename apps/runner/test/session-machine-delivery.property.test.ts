import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  initialModel,
  QUEUE_BOUND,
  transition,
  type MachineEvent,
  type Prompt,
  type TurnOutcome,
} from "../src/session/machine.js";

/**
 * P2: exactly-once, in-order delivery.
 * **Validates: Requirements 6.15, 6.10, 6.11, 6.12, 6.4, 6.9**
 */
const TAG =
  "Feature: agent-runner, Property 2: every enqueued prompt is sent or reported dropped exactly once, in enqueue order";

// A step is a non-enqueue event, a single enqueue, or a burst of up to 60 enqueues.
type Step =
  | { readonly kind: "event"; readonly event: MachineEvent }
  | { readonly kind: "burst"; readonly count: number };

const outcomeArb: fc.Arbitrary<TurnOutcome> = fc.oneof(
  fc.constantFrom<TurnOutcome>("end_turn", "cancelled", "other"),
  fc.record({ error: fc.string({ unit: "binary", maxLength: 20 }) }),
);

const otherEventArb: fc.Arbitrary<MachineEvent> = fc.oneof(
  { weight: 3, arbitrary: fc.constant<MachineEvent>({ kind: "cancel" }) },
  { weight: 4, arbitrary: outcomeArb.map((outcome): MachineEvent => ({ kind: "turn-ended", outcome })) },
  { weight: 3, arbitrary: fc.constant<MachineEvent>({ kind: "cooldown-elapsed" }) },
  { weight: 1, arbitrary: fc.constant<MachineEvent>({ kind: "begin-closing" }) },
  {
    weight: 1,
    arbitrary: fc
      .constantFrom("exorcism", "process-exit", "shutdown" as const)
      .map((reason): MachineEvent => ({ kind: "close", reason: reason as "exorcism" })),
  },
);

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 5, arbitrary: otherEventArb.map((event): Step => ({ kind: "event", event })) },
  { weight: 3, arbitrary: fc.constant<Step>({ kind: "burst", count: 1 }) },
  { weight: 3, arbitrary: fc.integer({ min: 1, max: 60 }).map((count): Step => ({ kind: "burst", count })) },
);

function run(steps: readonly Step[]): { enqueued: number[]; sent: number[]; dropped: number[] } {
  let model = initialModel();
  let nextId = 0;
  const enqueued: number[] = [];
  const sent: number[] = [];
  const dropped: number[] = [];

  const apply = (event: MachineEvent): void => {
    const result = transition(model, event);
    model = result.model;
    for (const effect of result.effects) {
      if (effect.kind === "send-prompt") sent.push(effect.prompt.id);
      if (effect.kind === "drop") dropped.push(effect.prompt.id);
    }
  };
  const enqueue = (): void => {
    const prompt: Prompt = { id: nextId++, text: `p${nextId}` };
    enqueued.push(prompt.id);
    apply({ kind: "enqueue", prompt });
  };

  for (const step of steps) {
    if (step.kind === "burst") for (let i = 0; i < step.count; i++) enqueue();
    else apply(step.event);
  }
  apply({ kind: "close", reason: "shutdown" });
  return { enqueued, sent, dropped };
}

describe("P2 exactly-once, in-order delivery", () => {
  it(TAG, () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 40 }), (steps) => {
        const { enqueued, sent, dropped } = run(steps);
        const all = [...sent, ...dropped];

        // No repeats, and sent ∩ dropped = ∅ (implied by uniqueness of the union).
        expect(new Set(all).size).toBe(all.length);
        // sent ∪ dropped = enqueued.
        expect([...all].sort((a, b) => a - b)).toEqual(enqueued);
        // sent is strictly increasing, i.e. in enqueue order.
        for (let i = 1; i < sent.length; i++) {
          expect(sent[i]!).toBeGreaterThan(sent[i - 1]!);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("a burst past the queue bound while prompting reports the oldest prompts dropped", () => {
    const burst = QUEUE_BOUND + 10;
    const { enqueued, sent, dropped } = run([{ kind: "burst", count: burst }]);
    expect(enqueued).toHaveLength(burst);
    expect(sent).toEqual([0]);
    expect(dropped).toHaveLength(burst - 1);
  });
});
