import type { ReactNode } from "react";
import { formatClock } from "../irc/index.js";
import type { Line } from "../irc/index.js";
import { IrcText, hasVisibleText } from "./Spans.js";

const ROW = "break-words whitespace-pre-wrap border-l-[3px] border-transparent pl-1 text-ghost-text";

function formatSignon(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  if (Number.isNaN(d.getTime())) return String(epochSeconds);
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

/**
 * One grouped WHOIS answer as consecutive classic-client lines between two `-`
 * separators. Every field is untrusted text rendered through IrcText.
 */
export function WhoisLines(props: {
  readonly line: Line;
  /** Minutes east of UTC used for the [HH:MM] prefix. */
  readonly offsetMinutes: number;
  /** Theme class for the nick colour (computed by the caller). */
  readonly nickClassName: string;
}): ReactNode {
  const { line } = props;
  const w = line.whois;
  if (w === undefined) return null;
  const clock = `[${formatClock(line.at, props.offsetMinutes)}]`;

  const row = (key: string, body: ReactNode, withNick = true): ReactNode => (
    <div key={key} className={ROW}>
      <span className="text-timestamp-dim">{clock}</span>
      {" "}
      {withNick ? (
        <>
          <b className={`font-bold ${props.nickClassName}`}>
            <IrcText text={w.nick} />
          </b>
          {" "}
        </>
      ) : null}
      {body}
    </div>
  );

  const rows: ReactNode[] = [row("sep-top", "-", false)];
  if (w.user !== undefined) {
    rows.push(
      row(
        "user",
        <>
          {"is "}
          <IrcText text={`${w.user.user}@${w.user.host}`} />
          {" * "}
          <IrcText text={w.user.realname} />
        </>,
      ),
    );
  }
  if (w.channels.length > 0) {
    rows.push(
      row(
        "channels",
        <>
          {"on "}
          <IrcText text={w.channels.join(" ")} />
        </>,
      ),
    );
  }
  if (w.server !== undefined) {
    rows.push(
      row(
        "server",
        <>
          {"using "}
          <IrcText text={w.server.name} />
          {hasVisibleText(w.server.info) ? (
            <>
              {" "}
              <IrcText text={w.server.info} />
            </>
          ) : null}
        </>,
      ),
    );
  }
  if (w.away !== undefined) {
    rows.push(
      row(
        "away",
        <>
          {"is away: "}
          <IrcText text={w.away} />
        </>,
      ),
    );
  }
  w.special.forEach((text, i) => {
    rows.push(row(`special-${i}`, <IrcText text={text} />));
  });
  if (w.idle !== undefined) {
    rows.push(row("idle", `has been idle ${Math.max(0, Math.floor(w.idle.seconds))}secs, signed on ${formatSignon(w.idle.signon)}`));
  }
  rows.push(row("end", "End of /WHOIS list."));
  rows.push(row("sep-bottom", "-", false));
  return <>{rows}</>;
}
