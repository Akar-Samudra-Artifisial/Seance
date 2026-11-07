import type { Clock, TimerHandle } from "../clock.js";

export const DEFAULT_IDLE_FLUSH_MS = 1500;

export type SentenceBufferOptions = {
  readonly clock: Clock;
  readonly emit: (sentence: string) => void;
  readonly idleMs?: number;
};

const TERMINATORS = new Set([".", "!", "?"]);
const WHITESPACE = /\s/;

/**
 * Collects streamed chunks and emits complete sentences in order.
 * A `.`, `!` or `?` ends a sentence when followed by whitespace; a newline ends
 * it immediately. A terminator at the very end of the buffer waits for the next
 * chunk, the idle flush or `flush()`.
 */
export class SentenceBuffer {
  readonly #clock: Clock;
  readonly #emit: (sentence: string) => void;
  readonly #idleMs: number;
  #buffer = "";
  #timer: TimerHandle | undefined;
  #disposed = false;

  constructor(opts: SentenceBufferOptions) {
    this.#clock = opts.clock;
    this.#emit = opts.emit;
    this.#idleMs = opts.idleMs ?? DEFAULT_IDLE_FLUSH_MS;
  }

  append(chunk: string): void {
    if (this.#disposed) return;
    this.#buffer += chunk;
    this.#drainSentences();
    this.#rearm();
  }

  /** End of Turn: emit the remaining non-whitespace text and empty the buffer. */
  flush(): void {
    this.#clearTimer();
    this.#flushRemainder();
  }

  dispose(): void {
    this.#disposed = true;
    this.#clearTimer();
    this.#buffer = "";
  }

  #drainSentences(): void {
    const sentences: string[] = [];
    let start = 0;
    let i = 0;
    const buf = this.#buffer;
    while (i < buf.length) {
      const ch = buf.charAt(i);
      let end = -1;
      if (ch === "\n") {
        end = i + 1;
      } else if (TERMINATORS.has(ch) && i + 1 < buf.length && WHITESPACE.test(buf.charAt(i + 1))) {
        end = i + 1;
      }
      if (end < 0) {
        i += 1;
        continue;
      }
      sentences.push(buf.slice(start, end));
      // Skip the whitespace run that separates this sentence from the next.
      let next = end;
      while (next < buf.length && WHITESPACE.test(buf.charAt(next))) next += 1;
      start = next;
      i = next;
    }
    this.#buffer = buf.slice(start);
    for (const s of sentences) this.#emitText(s);
  }

  #emitText(text: string): void {
    const trimmed = text.trim();
    if (trimmed !== "") this.#emit(trimmed);
  }

  #flushRemainder(): void {
    const rest = this.#buffer;
    this.#buffer = "";
    this.#emitText(rest);
  }

  #rearm(): void {
    this.#clearTimer();
    if (this.#buffer.trim() === "") return;
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = undefined;
      this.#flushRemainder();
    }, this.#idleMs);
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) {
      this.#clock.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }
}
