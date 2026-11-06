import { describe, expect, it } from "vitest";
import { EventBus, type IrcKickEvent } from "../src/event-bus.js";

const kick: IrcKickEvent = { channel: "#c", by: "op", target: "bot", reason: "bye" };

describe("EventBus", () => {
  it("delivers events to subscribers of that name only", () => {
    const bus = new EventBus();
    const kicks: IrcKickEvent[] = [];
    let modes = 0;
    bus.subscribe("irc.kick", (e) => kicks.push(e));
    bus.subscribe("irc.mode", () => modes++);
    bus.publish("irc.kick", kick);
    expect(kicks).toEqual([kick]);
    expect(modes).toBe(0);
  });

  it("stops delivery after unsubscribe", () => {
    const bus = new EventBus();
    let n = 0;
    const off = bus.subscribe("irc.kick", () => n++);
    bus.publish("irc.kick", kick);
    off();
    off();
    bus.publish("irc.kick", kick);
    expect(n).toBe(1);
  });

  it("reports listener errors without breaking publisher or other listeners", () => {
    const errors: unknown[] = [];
    const bus = new EventBus((_name, err) => errors.push(err));
    const boom = new Error("boom");
    let reached = false;
    bus.subscribe("irc.kick", () => {
      throw boom;
    });
    bus.subscribe("irc.kick", () => {
      reached = true;
    });
    expect(() => bus.publish("irc.kick", kick)).not.toThrow();
    expect(reached).toBe(true);
    expect(errors).toEqual([boom]);
  });
});
