import type { ReactNode } from "react";
import { formatClock, irc_lower, isKnownAgent, markersFor } from "../irc/index.js";
import type { Line } from "../irc/index.js";
import { IrcText, hasVisibleText } from "./Spans.js";
import { WhoisBlock } from "./WhoisBlock.js";

// Name -> theme token. Membership is decided by isKnownAgent (classify.ts).
const AGENT_NICK_CLASS: Readonly<Record<string, string>> = {
  coder: "text-nick-coder",
  reviewer: "text-nick-reviewer",
  researcher: "text-nick-researcher",
};

export function nickClass(nick: string): string {
  if (isKnownAgent(nick)) {
    const c = AGENT_NICK_CLASS[irc_lower(nick)];
    if (c !== undefined) return c;
  }
  return "text-nick-human";
}

function lineClass(line: Line): string {
  switch (line.kind) {
    case "join":
      return "text-ghost-green";
    case "system":
    case "motd":
    case "numeric":
    case "local":
    case "notice":
      return "text-ghost-purple";
    case "tool":
      return "text-ghost-purple italic";
    case "tool-denied":
      return "text-ghost-orange line-through decoration-1";
    case "kick":
      return "text-ghost-orange font-bold";
    case "exorcised":
    case "exorcised-kick":
      return "text-ghost-orange font-bold bg-ghost-orange/20";
    case "error":
      return "text-ghost-orange";
    default:
      return "text-ghost-text";
  }
}

function Nick(props: { readonly nick: string }): ReactNode {
  return <span className={nickClass(props.nick)}>{props.nick}</span>;
}

function Body(props: { readonly line: Line }): ReactNode {
  const { line } = props;
  const from = line.from ?? "";
  switch (line.kind) {
    case "message":
      return (
        <>
          {"<"}
          <Nick nick={from} />
          {"> "}
          <IrcText text={line.text} />
        </>
      );
    case "action":
      return (
        <>
          {"* "}
          <Nick nick={from} />
          {" "}
          <IrcText text={line.text} />
        </>
      );
    case "notice":
      return from === "" ? (
        <IrcText text={line.text} />
      ) : (
        <>
          {"-"}
          <Nick nick={from} />
          {"- "}
          <IrcText text={line.text} />
        </>
      );
    case "exorcised-kick": {
      const parts = line.exorcism;
      if (parts === undefined) return <IrcText text={line.text} />;
      return (
        <>
          {"*** "}
          <IrcText text={parts.agent} />
          {" has been exorcised by "}
          <IrcText text={parts.kicker} />
          {hasVisibleText(parts.reason) ? (
            <>
              {" ("}
              <IrcText text={parts.reason} />
              {")"}
            </>
          ) : null}
        </>
      );
    }
    default:
      return <IrcText text={line.text} />;
  }
}

export function ChatLine(props: {
  readonly line: Line;
  /** Minutes east of UTC used for the [HH:MM] prefix. */
  readonly offsetMinutes: number;
}): ReactNode {
  const { line } = props;
  if (line.kind === "whois" && line.whois !== undefined) {
    return <WhoisBlock line={line} offsetMinutes={props.offsetMinutes} />;
  }
  const markers = markersFor(line.kind, line.mention);
  const mention = line.mention ? " border-l-2 border-ghost-orange bg-ghost-orange/20" : "";
  return (
    <div className={`break-words whitespace-pre-wrap ${lineClass(line)}${mention}`}>
      {`[${formatClock(line.at, props.offsetMinutes)}] `}
      {markers.length > 0 ? `${markers.join(" ")} ` : null}
      <Body line={line} />
    </div>
  );
}
