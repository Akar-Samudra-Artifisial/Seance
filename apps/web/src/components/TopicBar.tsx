import type { ReactNode } from "react";

export const NO_TOPIC_TEXT = "(no topic set)";

/** Channel topic line. The topic is untrusted text and is rendered as a plain React text node. */
export function TopicBar(props: { readonly topic: string | undefined }): ReactNode {
  const { topic } = props;
  const hasTopic = topic !== undefined && topic !== "";
  return (
    <p
      aria-label="Channel topic"
      className="bevel-sunken truncate bg-chrome-face px-1 font-chrome text-sm text-chrome-outline"
    >
      {hasTopic ? topic : NO_TOPIC_TEXT}
    </p>
  );
}
