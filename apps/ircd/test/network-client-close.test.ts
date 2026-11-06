import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../src/limits.js";
import { loadConfig } from "../src/config.js";
import { NetworkClient } from "../src/network-client.js";
import type { Wire } from "../src/network-client.js";
import type { TimerApi, TimerHandle } from "../src/connection-manager.js";
import { createServer } from "../src/server.js";

const GRACE_MS = 2000;

/** Manual timers: records every schedule and exposes what is still pending. */
function fakeTimers() {
  let seq = 0;
  const pending = new Map<number, () => void>();
  const state = { scheduled: 0, cleared: 0 };
  const timers: TimerApi = {
    setTimeout(fn: () => void, _ms: number): TimerHandle {
      seq += 1;
      state.scheduled += 1;
      pending.set(seq, fn);
      return seq;
    },
    clearTimeout(handle: TimerHandle): void {
      state.cleared += 1;
      pending.delete(handle as number);
    },
  };
  /** Fire every pending timer (the grace period elapsed). */
  const elapse = (): void => {
    for (const [id, fn] of [...pending]) {
      pending.delete(id);
      fn();
    }
  };
  return { timers, state, pending, elapse };
}

function fakeWire(destroyedAtStart = false) {
  const state = { written: [] as string[], ended: 0, destroyed: 0, isDestroyed: destroyedAtStart };
  const wire: Wire = {
    write: (line) => {
      state.written.push(line);
    },
    end: () => {
      state.ended += 1;
    },
    destroy: () => {
      state.destroyed += 1;
      state.isDestroyed = true;
    },
    bufferedBytes: () => 0,
    isDestroyed: () => state.isDestroyed,
  };
  return { wire, state };
}

function setup(destroyedAtStart = false) {
  const server = createServer(loadConfig({}), { error: () => {} });
  const t = fakeTimers();
  const w = fakeWire(destroyedAtStart);
  const client = new NetworkClient("n1", "203.0.113.9", w.wire, server.ctx, {
    ...DEFAULT_LIMITS,
    closeGraceMs: GRACE_MS,
    timers: t.timers,
  });
  return { client, wire: w.state, timers: t };
}

describe("NetworkClient.close", () => {
  it("on an already destroyed wire marks closed without end() or a timer (Req 10.1, 10.2)", () => {
    const { client, wire, timers } = setup(true);
    client.close("bye");
    expect(client.isClosed).toBe(true);
    expect(wire.ended).toBe(0);
    expect(wire.destroyed).toBe(0);
    expect(wire.written).toEqual([]);
    expect(timers.state.scheduled).toBe(0);
    expect(timers.pending.size).toBe(0);
  });

  it("on a live wire sends ERROR, ends once and arms one timer (Req 10.3)", () => {
    const { client, wire, timers } = setup();
    client.close("bye");
    expect(client.isClosed).toBe(true);
    expect(wire.written).toEqual(["ERROR :Closing Link: bye\r\n"]);
    expect(wire.ended).toBe(1);
    expect(wire.destroyed).toBe(0);
    expect(timers.state.scheduled).toBe(1);
    expect(timers.pending.size).toBe(1);
  });

  it("repeated close does nothing more (Req 10.4)", () => {
    const { client, wire, timers } = setup();
    client.close("first");
    client.close("second");
    client.close("third");
    expect(wire.written).toEqual(["ERROR :Closing Link: first\r\n"]);
    expect(wire.ended).toBe(1);
    expect(timers.state.scheduled).toBe(1);
    expect(timers.pending.size).toBe(1);
  });

  it("dispose after the wire was destroyed during grace cancels the timer (Req 10.5)", () => {
    const { client, wire, timers } = setup();
    client.close("bye");
    wire.isDestroyed = true; // peer closed its side during the grace period
    client.dispose();
    expect(timers.state.cleared).toBe(1);
    expect(timers.pending.size).toBe(0);
    timers.elapse();
    expect(wire.destroyed).toBe(0);
  });

  it("calls destroy() once when the grace period elapses and leaves no timer (Req 10.3, 10.5)", () => {
    const { client, wire, timers } = setup();
    client.close("bye");
    timers.elapse();
    expect(wire.destroyed).toBe(1);
    expect(timers.pending.size).toBe(0);
    client.close("again");
    client.dispose();
    timers.elapse();
    expect(wire.destroyed).toBe(1);
    expect(timers.state.scheduled).toBe(1);
    expect(timers.pending.size).toBe(0);
  });
});
