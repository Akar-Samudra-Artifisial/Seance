import type { ReactNode } from "react";
import { formatIrc, modeSuffix } from "../irc/index.js";
import { IrcText } from "./Spans.js";

function plain(text: string): string {
  return formatIrc(text)
    .map((s) => s.text)
    .join("");
}

/**
 * Channel topic line: `<channel> (<modes>): <topic>`. Modes and topic are omitted when empty.
 * All server-supplied strings are untrusted and rendered through IrcText as React text.
 */
export function TopicBar(props: {
  readonly channel: string;
  readonly modes: string | undefined;
  readonly topic: string | undefined;
}): ReactNode {
  const { channel, modes, topic } = props;
  const suffix = modeSuffix(modes ?? "");
  const topicPlain = topic === undefined ? "" : plain(topic);
  const hasTopic = topicPlain !== "";
  const full = `${plain(channel)}${suffix}${hasTopic ? `: ${topicPlain}` : ""}`;
  return (
    <p
      aria-label="Channel topic"
      title={full}
      className="bevel-field h-(--layout-topic) shrink-0 truncate whitespace-nowrap bg-ghost-bg px-2 font-chat text-sm leading-(--layout-topic) text-ghost-text"
    >
      <span className="text-ghost-orange">
        <IrcText text={channel} />
      </span>
      {suffix === "" ? null : (
        <span className="text-timestamp-dim">
          {" ("}
          <IrcText text={suffix.slice(2, -1)} />
          {")"}
        </span>
      )}
      {hasTopic ? (
        <>
          {": "}
          <IrcText text={topic ?? ""} />
        </>
      ) : null}
    </p>
  );
}
