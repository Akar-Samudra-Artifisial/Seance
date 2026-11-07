import type { ReactNode } from "react";
import { formatClock } from "../irc/index.js";
import type { Line } from "../irc/index.js";
import { IrcText, hasVisibleText } from "./Spans.js";

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function Row(props: { readonly label: string; readonly children: ReactNode }): ReactNode {
  return (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 text-ghost-purple">{props.label}</dt>
      <dd className="min-w-0 break-words">{props.children}</dd>
    </div>
  );
}

/** One grouped WHOIS answer. Every field is untrusted text rendered through formatIrc/Spans. */
export function WhoisBlock(props: {
  readonly line: Line;
  /** Minutes east of UTC used for the [HH:MM] prefix and sign-on time. */
  readonly offsetMinutes: number;
}): ReactNode {
  const { line } = props;
  const w = line.whois;
  if (w === undefined) return null;
  const signon =
    w.idle === undefined
      ? undefined
      : new Date(w.idle.signon * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
  return (
    <section
      role="group"
      aria-label={`WHOIS ${w.nick}`}
      className="my-1 border border-ghost-purple bg-ghost-bg/80 p-1 text-ghost-text"
    >
      <h3 className="font-bold text-ghost-green">
        {`[${formatClock(line.at, props.offsetMinutes)}] WHOIS `}
        <IrcText text={w.nick} />
      </h3>
      <dl className="m-0">
        {w.user !== undefined ? (
          <>
            <Row label="user">
              <IrcText text={`${w.user.user}@${w.user.host}`} />
            </Row>
            <Row label="realname">
              <IrcText text={w.user.realname} />
            </Row>
          </>
        ) : null}
        {w.server !== undefined ? (
          <Row label="server">
            <IrcText text={w.server.name} />
            {hasVisibleText(w.server.info) ? (
              <>
                {" ("}
                <IrcText text={w.server.info} />
                {")"}
              </>
            ) : null}
          </Row>
        ) : null}
        {w.channels.length > 0 ? (
          <Row label="channels">
            <IrcText text={w.channels.join(" ")} />
          </Row>
        ) : null}
        {w.idle !== undefined ? (
          <>
            <Row label="idle">{formatDuration(w.idle.seconds)}</Row>
            <Row label="signon">{signon}</Row>
          </>
        ) : null}
        {w.away !== undefined ? (
          <Row label="away">
            <span className="italic">
              <IrcText text={w.away} />
            </span>
          </Row>
        ) : null}
        {w.special.map((text, i) => (
          <Row key={i} label="info">
            <span className="text-ghost-orange">
              <IrcText text={text} />
            </span>
          </Row>
        ))}
      </dl>
    </section>
  );
}
