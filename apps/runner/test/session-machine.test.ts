import { describe, expect, it } from "vitest";
import {
  QUEUE_BOUND,
  initialModel,
  transition,
  type MachineEvent,
  type Prompt,
  type SessionModel,
} from "../src/session/machine.js";

const p = (id: number): Prompt => ({ id, text: `msg ${id}` });
const enqueue = (id: number): MachineEvent => ({ kind: "enqueue", prompt: p(id) });
const ended = (outcome: Extract<MachineEvent, { kind: "turn-ended" }>["outcome"]): MachineEvent => ({
  kind: "turn-ended",
  outcome,
});

function run(model: SessionModel, ...events: readonly MachineEvent[]): SessionModel {
  return events.reduce((m, e) => transition(m, e).model, model);
}

const prompting = (): SessionModel => run(initialModel(), enqueue(1));

describe("session machine transition table", () => {
  it("sends an enqueued prompt immediately when idle (6.2)", () => {
    const r = transition(initialModel(), enqueue(1));
    expect(r.model.state).toBe("prompting");
    expect(r.model.inFlight).toEqual(p(1));
    expect(r.model.queue).toEqual([]);
    expect(r.effects).toEqual([{ kind: "send-prompt", prompt: p(1) }]);
  });

  it("queues prompts while busy (6.3)", () => {
    const r = transition(prompting(), enqueue(2));
    expect(r.model.state).toBe("prompting");
    expect(r.model.inFlight).toEqual(p(1));
    expect(r.model.queue).toEqual([p(2)]);
    expect(r.effects).toEqual([]);
  });

  it("drains the oldest queued prompt on end_turn (6.4)", () => {
    const m = run(prompting(), enqueue(2), enqueue(3));
    const r = transition(m, ended("end_turn"));
    expect(r.model.state).toBe("prompting");
    expect(r.model.inFlight).toEqual(p(2));
    expect(r.model.queue).toEqual([p(3)]);
    expect(r.effects).toEqual([{ kind: "send-prompt", prompt: p(2) }]);
  });

  it("goes idle on end_turn with an empty queue (6.4)", () => {
    const r = transition(prompting(), ended("end_turn"));
    expect(r.model.state).toBe("idle");
    expect(r.model.inFlight).toBeUndefined();
    expect(r.effects).toEqual([]);
  });

  it("notifies ops on failure and still drains (6.5)", () => {
    const m = run(prompting(), enqueue(2));
    const r = transition(m, ended({ error: "boom" }));
    expect(r.effects[0]).toEqual({ kind: "notify-ops", text: "prompt failed: boom" });
    expect(r.effects[1]).toEqual({ kind: "send-prompt", prompt: p(2) });
    expect(r.model.state).toBe("prompting");

    const other = transition(prompting(), ended("other"));
    expect(other.effects).toHaveLength(1);
    expect(other.effects[0]?.kind).toBe("notify-ops");
    expect(other.model.state).toBe("idle");
  });

  it("sends cancel exactly once while prompting (6.6)", () => {
    const first = transition(prompting(), { kind: "cancel" });
    expect(first.model.state).toBe("cancelling");
    expect(first.effects).toEqual([{ kind: "send-cancel" }]);
    const second = transition(first.model, { kind: "cancel" });
    expect(second.effects).toEqual([]);
    expect(second.model).toBe(first.model);
  });

  it("ignores cancel outside prompting (6.7)", () => {
    const idle = initialModel();
    const cooldown = run(prompting(), { kind: "cancel" }, ended("cancelled"));
    const closed = run(idle, { kind: "close", reason: "shutdown" });
    for (const m of [idle, cooldown, closed]) {
      const r = transition(m, { kind: "cancel" });
      expect(r.effects).toEqual([]);
      expect(r.model).toBe(m);
    }
  });

  it("enters cooldown after a requested cancel resolves, then drains when it elapses (6.8)", () => {
    const m = run(prompting(), enqueue(2), { kind: "cancel" });
    const cd = transition(m, ended("cancelled"));
    expect(cd.model.state).toBe("cooldown");
    expect(cd.effects).toEqual([{ kind: "start-cooldown" }]);
    // no prompt is sent during cooldown
    const queued = transition(cd.model, enqueue(3));
    expect(queued.effects).toEqual([]);
    const done = transition(cd.model, { kind: "cooldown-elapsed" });
    expect(done.model.state).toBe("prompting");
    expect(done.model.inFlight).toEqual(p(2));
    expect(done.effects).toEqual([{ kind: "stop-cooldown" }, { kind: "send-prompt", prompt: p(2) }]);
  });

  it("goes idle when cooldown elapses with an empty queue (6.8)", () => {
    const cd = run(prompting(), { kind: "cancel" }, ended("cancelled"));
    const r = transition(cd, { kind: "cooldown-elapsed" });
    expect(r.model.state).toBe("idle");
  });

  it("drops the oldest prompt with an ops notice on overflow (6.9, 6.10)", () => {
    let m = prompting();
    for (let i = 2; i < 2 + QUEUE_BOUND; i++) m = run(m, enqueue(i));
    expect(m.queue).toHaveLength(QUEUE_BOUND);
    const r = transition(m, enqueue(100));
    expect(r.model.queue).toHaveLength(QUEUE_BOUND);
    expect(r.model.queue[0]).toEqual(p(3));
    expect(r.model.queue.at(-1)).toEqual(p(100));
    expect(r.effects[0]).toEqual({ kind: "drop", prompt: p(2), why: "overflow" });
    expect(r.effects[1]?.kind).toBe("notify-ops");
  });

  it("drops the queue on close (6.11)", () => {
    const m = run(prompting(), enqueue(2), enqueue(3));
    const r = transition(m, { kind: "close", reason: "exorcism" });
    expect(r.model.state).toBe("closed");
    expect(r.model.queue).toEqual([]);
    expect(r.model.inFlight).toBeUndefined();
    expect(r.effects).toContainEqual({ kind: "drop", prompt: p(2), why: "closed" });
    expect(r.effects).toContainEqual({ kind: "drop", prompt: p(3), why: "closed" });
  });

  it("rejects every prompt once closed (6.12)", () => {
    const closed = run(initialModel(), { kind: "close", reason: "process-exit" });
    const r = transition(closed, enqueue(1));
    expect(r.model).toBe(closed);
    expect(r.effects).toEqual([{ kind: "drop", prompt: p(1), why: "closed" }]);
  });

  it("goes to cooldown on an unrequested cancelled outcome (6.13)", () => {
    const r = transition(prompting(), ended("cancelled"));
    expect(r.model.state).toBe("cooldown");
    expect(r.model.inFlight).toBeUndefined();
    expect(r.effects).toEqual([{ kind: "start-cooldown" }]);
  });

  it("starts a replacement session from a fresh model after closed (6.13)", () => {
    const closed = run(prompting(), { kind: "close", reason: "shutdown" });
    expect(closed.state).toBe("closed");
    expect(initialModel()).toEqual({ state: "idle", queue: [], inFlight: undefined, closing: false });
  });
});
