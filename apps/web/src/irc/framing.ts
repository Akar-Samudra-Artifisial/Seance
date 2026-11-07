import type { LineFramer } from "@seance/irc-protocol";

/** A complete inbound line, terminator removed. */
export type DecodedLine = { readonly kind: "line"; readonly line: string };

/** An inbound line above 512 bytes including CRLF; it was discarded. */
export type DecodedOverlong = { readonly kind: "overlong" };

export type DecodedFrame = DecodedLine | DecodedOverlong;

/**
 * Feeds one WebSocket text frame to the framer and returns the lines it
 * completes, in order. A frame may hold several lines or a partial line; the
 * partial tail stays buffered in the framer for the next frame.
 */
export function decodeFrames(framer: LineFramer, frame: string): readonly DecodedFrame[] {
  return framer.push(frame).map((event): DecodedFrame =>
    event.kind === "line" ? { kind: "line", line: event.line } : { kind: "overlong" },
  );
}
