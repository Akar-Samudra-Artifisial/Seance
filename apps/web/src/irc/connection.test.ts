import { describe, expect, it } from "vitest";
import { stepConnection, type ConnectionEvent } from "./connection.js";
import type { ConnectionPhase } from "./types.js";

const ev = (type: ConnectionEvent["type"]): ConnectionEvent => ({ type }) as ConnectionEvent;

describe("stepConnection", () => {
  it.each<[ConnectionPhase, ConnectionEvent["type"], ConnectionPhase]>([
    ["disconnected", "connect", "connecting"],
    ["failed", "connect", "connecting"],
    ["connecting", "socket-open", "registering"],
    ["registering", "welcome", "registered"],
    ["registering", "reject", "failed"],
    ["connecting", "socket-closed", "failed"],
    ["registering", "socket-closed", "failed"],
    ["registered", "socket-closed", "disconnected"],
    ["registering", "user-cancel", "disconnected"],
  ])("%s --%s--> %s", (from, type, to) => {
    expect(stepConnection(from, ev(type))).toBe(to);
  });

  it("ignores events that do not apply to the current phase", () => {
    expect(stepConnection("registered", ev("connect"))).toBe("registered");
    expect(stepConnection("disconnected", ev("welcome"))).toBe("disconnected");
    expect(stepConnection("registered", ev("reject"))).toBe("registered");
    expect(stepConnection("failed", ev("socket-closed"))).toBe("failed");
    expect(stepConnection("disconnected", ev("socket-closed"))).toBe("disconnected");
    expect(stepConnection("registered", ev("user-cancel"))).toBe("registered");
  });
});
