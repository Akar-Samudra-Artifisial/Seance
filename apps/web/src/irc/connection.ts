import type { ConnectionPhase } from "./types.js";

/** Events that drive the connection machine. */
export type ConnectionEvent =
  | { readonly type: "connect" }
  | { readonly type: "socket-open" }
  | { readonly type: "welcome" }
  | { readonly type: "reject" }
  | { readonly type: "socket-closed" }
  | { readonly type: "user-cancel" };

/**
 * Pure transition function for the connection phase.
 * Events that do not apply to the current phase leave it unchanged.
 */
export function stepConnection(phase: ConnectionPhase, event: ConnectionEvent): ConnectionPhase {
  switch (event.type) {
    case "connect":
      return phase === "disconnected" || phase === "failed" ? "connecting" : phase;
    case "socket-open":
      return phase === "connecting" ? "registering" : phase;
    case "welcome":
      return phase === "registering" ? "registered" : phase;
    case "reject":
      return phase === "registering" ? "failed" : phase;
    case "socket-closed":
      // Error or close before 001 fails; close after registration is a plain disconnect.
      if (phase === "connecting" || phase === "registering") return "failed";
      if (phase === "registered") return "disconnected";
      return phase;
    case "user-cancel":
      return phase === "registering" ? "disconnected" : phase;
  }
}
