/** Maximum wire length of one message, CRLF included, in UTF-8 bytes. */
const MAX_LINE_BYTES = 512;

/** Longest line body (terminator excluded) that still fits with a CRLF. */
const MAX_BODY_BYTES = MAX_LINE_BYTES - 2;

const CR = 0x0d;
const LF = 0x0a;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

/** A complete, non-empty line with its terminator removed. */
export type FramedLine = { readonly kind: "line"; readonly line: string };

/**
 * An inbound line that exceeded 512 UTF-8 bytes including CRLF. It was
 * discarded; the transport should reply `417 ERR_INPUTTOOLONG` and keep the
 * connection open. Emitted exactly once per overlong line.
 */
export type FramedOverlong = { readonly kind: "overlong" };

export type FramerEvent = FramedLine | FramedOverlong;

/**
 * Splits a byte or text stream into IRC lines.
 *
 * - Terminates lines on CRLF or a bare LF; empty lines are discarded.
 * - Buffers raw bytes, so a multi-byte UTF-8 sequence split across chunks is
 *   decoded correctly once its line completes.
 * - Memory is bounded: once an in-progress line can no longer fit in 512
 *   bytes including CRLF, it is dropped, a single `overlong` event is emitted,
 *   and input is skipped up to the next LF.
 *
 * Pure: no I/O and no timers, so every transport shares it.
 */
export class LineFramer {
  private readonly buffer = new Uint8Array(MAX_LINE_BYTES);
  private length = 0;
  private discarding = false;

  /**
   * Feed one chunk and return the events it completes, in order. An incomplete
   * trailing line stays buffered for later chunks.
   */
  push(chunk: Uint8Array | string): readonly FramerEvent[] {
    const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
    const events: FramerEvent[] = [];

    for (const byte of bytes) {
      if (byte === LF) {
        if (this.discarding) {
          this.discarding = false;
        } else {
          this.finishLine(events);
        }
        this.length = 0;
        continue;
      }
      if (this.discarding) {
        continue;
      }
      if (this.length >= MAX_LINE_BYTES) {
        // 512 bytes without a terminator: the line cannot fit once LF arrives.
        this.discarding = true;
        this.length = 0;
        events.push({ kind: "overlong" });
        continue;
      }
      this.buffer[this.length] = byte;
      this.length += 1;
    }
    return events;
  }

  private finishLine(events: FramerEvent[]): void {
    let end = this.length;
    if (end > 0 && this.buffer[end - 1] === CR) {
      end -= 1;
    }
    if (end === 0) {
      return;
    }
    if (end > MAX_BODY_BYTES) {
      events.push({ kind: "overlong" });
      return;
    }
    events.push({ kind: "line", line: decoder.decode(this.buffer.subarray(0, end)) });
  }
}
