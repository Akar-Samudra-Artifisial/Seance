/**
 * Hung-agent handling (Req 9.13).
 *
 * On a harness `{kind: "hung"}` event, post `NOTICE timeout` to every channel in which the
 * process has a `prompting` Session. The harness itself sends SIGTERM and rejects the
 * In_Flight_Prompts, which then run the normal exit path; nothing else happens here.
 */

import type { ProcessEvent } from "../harness/harness.js";
import type { Unsubscribe } from "../ports.js";
import type { SessionState } from "./machine.js";

/** The text posted to each prompting channel. */
export const HUNG_NOTICE_TEXT = "timeout";

/** The part of a Session this handler reads. */
export interface HungSessionView {
  readonly channel: string;
  readonly state: SessionState;
}

/** The part of AgentOutput this handler uses. */
export interface HungNoticeOutput {
  channelNotice(channel: string, text: string): void;
}

export type HungHandlerDeps = {
  /** All Sessions (any state) of the named agent's process. */
  readonly sessionsOfAgent: (agent: string) => readonly HungSessionView[];
  /** The agent's output; undefined when the agent is unknown. */
  readonly outputOf: (agent: string) => HungNoticeOutput | undefined;
  /** Reports a failed notice; the remaining channels are still served. */
  readonly onError?: (channel: string, error: unknown) => void;
};

/** Returns the channels that were sent the notice, in session order. */
export function handleHung(
  event: Extract<ProcessEvent, { readonly kind: "hung" }>,
  deps: HungHandlerDeps,
): readonly string[] {
  const output = deps.outputOf(event.agent);
  if (output === undefined) return [];

  const notified: string[] = [];
  const seen = new Set<string>();
  for (const session of deps.sessionsOfAgent(event.agent)) {
    if (session.state !== "prompting" || seen.has(session.channel)) continue;
    seen.add(session.channel);
    try {
      output.channelNotice(session.channel, HUNG_NOTICE_TEXT);
      notified.push(session.channel);
    } catch (error) {
      deps.onError?.(session.channel, error);
    }
  }
  return notified;
}

/** Subscribes `handleHung` to a harness's process events. */
export function installHungHandler(
  harness: { onProcessEvent(listener: (e: ProcessEvent) => void): Unsubscribe },
  deps: HungHandlerDeps,
): Unsubscribe {
  return harness.onProcessEvent((e) => {
    if (e.kind === "hung") handleHung(e, deps);
  });
}
