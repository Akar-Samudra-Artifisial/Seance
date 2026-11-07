import type { Clock } from "../clock.js";
import type { SessionEvent, ToolInfo } from "../harness/harness.js";
import type { Unsubscribe } from "../ports.js";
import type { Session } from "../session/session.js";
import type { AgentOutput } from "./agent-output.js";
import { SentenceBuffer } from "./sentence-buffer.js";

export type SessionOutputOptions = {
  readonly session: Pick<Session, "channel" | "sessionEvents" | "turnEnding">;
  readonly output: Pick<AgentOutput, "say" | "toolStarted" | "clearAway">;
  readonly clock: Clock;
  readonly idleMs?: number;
};

/** One-line, untrusted summary of a tool call for AWAY and the channel NOTICE. */
function summarize(tool: ToolInfo): string {
  const title = tool.title.trim() !== "" ? tool.title.trim() : tool.kind;
  return `using tool: ${title}`;
}

/**
 * Connects a Session's harness events to IRC output: message chunks feed a
 * SentenceBuffer that says each sentence in the channel; tool calls set AWAY
 * and notice the channel; thought chunks and other events send nothing. Before
 * the Turn is reported as ended the buffer is flushed and AWAY is cleared.
 * Returns a function that detaches and disposes everything.
 */
export function attachSessionOutput(opts: SessionOutputOptions): Unsubscribe {
  const { session, output } = opts;
  const channel = session.channel;
  const buffer = new SentenceBuffer({
    clock: opts.clock,
    emit: (sentence) => {
      output.say(channel, sentence);
    },
    ...(opts.idleMs !== undefined ? { idleMs: opts.idleMs } : {}),
  });

  const offEvents = session.sessionEvents((e: SessionEvent) => {
    switch (e.kind) {
      case "message-chunk":
        buffer.append(e.text);
        return;
      case "tool-call":
        // Keep earlier text ahead of the tool notice.
        buffer.flush();
        output.toolStarted(channel, summarize(e.tool));
        return;
      default:
        return; // thought-chunk, metadata, unknown: nothing goes to IRC
    }
  });

  const offEnding = session.turnEnding(() => {
    try {
      buffer.flush();
    } finally {
      output.clearAway();
    }
  });

  return () => {
    offEvents();
    offEnding();
    buffer.dispose();
  };
}
