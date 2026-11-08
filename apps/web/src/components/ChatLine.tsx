import type { ReactNode } from "react";
import { EVENT_LINE_KINDS, exorcismText, formatClock, irc_lower, isKnownAgent, keyOf, markersFor } from "../irc/index.js";
import type { Line, Member } from "../irc/index.js";
import { NickAgentResearcherAway } from "../icons/index.js";
import { IrcText } from "./Spans.js";
import { WhoisLines } from "./WhoisLines.js";
import { memberPrefix } from "../irc/nick-order.js";

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

/** Kinds that read as `*** text` Event_Lines: the event-green kinds plus kick and exorcism. */
const EVENT_KINDS: ReadonlySet<Line["kind"]> = new Set([...EVENT_LINE_KINDS, "kick", "exorcised"]);

const SESSION_START = /^--- Session start: /;

export function lineClass(line: Line): string {
  // web-client-pixel-match R6.1: every `***` event line uses the event green.
  if (EVENT_LINE_KINDS.includes(line.kind)) return "text-event-green";
  switch (line.kind) {
    case "action":
      return "text-action-purple";
    case "notice":
      return "text-ghost-orange";
    case "system":
      return SESSION_START.test(line.text) ? "text-timestamp-dim" : "text-action-purple";
    case "local":
      return "text-action-purple";
    case "tool":
      return "text-tool-grey italic";
    case "tool-denied":
      return "text-tool-grey line-through decoration-1";
    case "kick":
      return "text-ghost-orange font-bold";
    case "exorcised":
      return "text-ghost-orange font-bold bg-ghost-orange/20";
    case "exorcised-kick":
      return "text-ghost-text";
    case "error":
      return "text-ghost-orange";
    default:
      return "text-ghost-text";
  }
}

/** Chat prefix of `nick` in the channel at render time: "@", "+" or "". */
export function chatPrefix(members: Readonly<Record<string, Member>> | undefined, nick: string): string {
  if (members === undefined) return "";
  const key = keyOf(nick);
  if (!Object.hasOwn(members, key)) return "";
  const member = members[key];
  return member === undefined ? "" : memberPrefix(member);
}

function Nick(props: { readonly nick: string; readonly prefix?: string }): ReactNode {
  return (
    <span className={nickClass(props.nick)}>
      {props.prefix ?? ""}
      {props.nick}
    </span>
  );
}

function Event(props: { readonly line: Line }): ReactNode {
  const { line } = props;
  const from = line.from;
  const p = line.prefix;
  if (from !== undefined && p !== undefined && line.text.startsWith(from)) {
    return (
      <>
        {"*** "}
        <IrcText text={from} />
        {" ("}
        <IrcText text={`${p.user}@${p.host}`} />
        {")"}
        <IrcText text={line.text.slice(from.length)} />
      </>
    );
  }
  return (
    <>
      {"*** "}
      <IrcText text={line.text} />
    </>
  );
}

function Body(props: {
  readonly line: Line;
  readonly members: Readonly<Record<string, Member>> | undefined;
  readonly ownNick: string | undefined;
}): ReactNode {
  const { line } = props;
  const from = line.from ?? "";
  const highlight = line.mention ? props.ownNick : undefined;
  const text = highlight === undefined ? <IrcText text={line.text} /> : <IrcText text={line.text} highlight={highlight} />;
  switch (line.kind) {
    case "message":
      return (
        <>
          {"<"}
          <Nick nick={from} prefix={chatPrefix(props.members, from)} />
          {"> "}
          {text}
        </>
      );
    case "action":
      return (
        <>
          {"* "}
          <Nick nick={from} />
          {" "}
          {text}
        </>
      );
    case "notice":
      return from === "" ? (
        text
      ) : (
        <>
          {"-"}
          <Nick nick={from} />
          {"- "}
          {text}
        </>
      );
    case "exorcised-kick": {
      if (line.exorcism === undefined) return <IrcText text={line.text} />;
      const parts = exorcismText(line.exorcism);
      return (
        <>
          {"*** "}
          <span className={`${nickClass(parts.agent)} line-through opacity-60`}>
            <IrcText text={parts.agent} />
          </span>
          {" has been "}
          <span className="font-bold text-ghost-orange">exorcised</span>
          {" by "}
          <IrcText text={parts.kicker} />
          {parts.reason !== undefined ? (
            <>
              {" ("}
              <IrcText text={parts.reason} />
              {")"}
            </>
          ) : null}
          <span role="img" aria-label="exorcised" className="ml-1 inline-flex align-middle">
            <NickAgentResearcherAway />
          </span>
        </>
      );
    }
    default:
      if (EVENT_KINDS.has(line.kind)) return <Event line={line} />;
      if (line.code !== undefined) {
        if (line.kind === "motd" && line.code === "375") {
          return (
            <>
              <span className="text-timestamp-dim">{line.code}</span>
              {" "}
              <strong className="font-bold">
                <IrcText text={line.text} />
              </strong>
            </>
          );
        }
        return (
          <>
            <span className="text-timestamp-dim">{line.code}</span>
            {" "}
            <IrcText text={line.text} />
          </>
        );
      }
      return <IrcText text={line.text} />;
  }
}

export function ChatLine(props: {
  readonly line: Line;
  /** Minutes east of UTC used for the [HH:MM] prefix. */
  readonly offsetMinutes: number;
  /** Members of the channel at render time; decides the `@` / `+` chat prefix. */
  readonly members?: Readonly<Record<string, Member>> | undefined;
  /** Own nick, shown bold in the accent colour inside mention lines. */
  readonly ownNick?: string | undefined;
}): ReactNode {
  const { line } = props;
  if (line.kind === "whois" && line.whois !== undefined) {
    return <WhoisLines line={line} offsetMinutes={props.offsetMinutes} nickClassName={nickClass(line.whois.nick)} />;
  }
  const markers = markersFor(line.kind, false);
  const row = line.mention
    ? "border-mention-bar bg-ghost-orange/20"
    : line.kind === "exorcised-kick"
      ? "border-ghost-purple bg-ghost-purple/10"
      : "border-transparent";
  // MOTD lines keep their spaces and never wrap, so server ASCII art keeps its shape.
  const wrap = line.kind === "motd" ? "overflow-x-auto whitespace-pre" : "break-words whitespace-pre-wrap";
  return (
    <div className={`${wrap} border-l-[3px] pl-1 ${row} ${lineClass(line)}`}>
      <span className="text-timestamp-dim">{`[${formatClock(line.at, props.offsetMinutes)}]`}</span>
      {" "}
      {line.mention ? <span className="sr-only">[mention] </span> : null}
      {markers.length > 0 ? `${markers.join(" ")} ` : null}
      <Body line={line} members={props.members} ownNick={props.ownNick} />
    </div>
  );
}
