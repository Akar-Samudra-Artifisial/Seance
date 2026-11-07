import type { HostVirtualClient, IrcHost } from "../ports.js";
import type { RunnerLogger } from "../log.js";
import type { WhoisSnapshot } from "../whois/snapshot.js";
import { redact, redactValues } from "../acp/redact.js";
import { budgetFor, formatLines, stripControls } from "./line-format.js";

/** The runner clamps AWAY to this many bytes, matching what the ircd stores. */
export const AWAY_MAX_BYTES = 200;

/** Removes CR, LF and NUL, then cuts at a code point boundary to at most `maxBytes` UTF-8 bytes. */
export function truncateBytes(text: string, maxBytes: number): string {
  const clean = stripControls(text);
  let out = "";
  let bytes = 0;
  for (const cp of clean) {
    const size = Buffer.byteLength(cp, "utf8");
    if (bytes + size > maxBytes) break;
    out += cp;
    bytes += size;
  }
  return out;
}

export type AgentOutputOptions = {
  readonly client: HostVirtualClient;
  readonly logger: RunnerLogger;
  readonly nick: string;
  /** USER name of the virtual client; with `host` it forms the exact prefix the ircd adds. */
  readonly user: string;
  readonly host: string;
  /** Agent_Color, 0..99. */
  readonly color: number;
  readonly snapshot?: WhoisSnapshot;
  /** Known secret values (for example KIRO_API_KEY) removed from every outgoing text. */
  readonly secrets?: readonly (string | undefined)[];
};

/**
 * Sends agent text into IRC. Agent text only ever travels as the trailing
 * parameter of a PRIVMSG or NOTICE; it is never parsed, executed or routed as a
 * command, so a leading `/` is plain text.
 */
export class AgentOutput {
  readonly #o: AgentOutputOptions;

  constructor(options: AgentOutputOptions) {
    this.#o = options;
  }

  #prefix(): string {
    return `${this.#o.nick}!${this.#o.user}@${this.#o.host}`;
  }

  /** Strips controls first (so obfuscated secrets match), then redacts known values and secret-looking keys. */
  #clean(text: string): string {
    return redact(redactValues(stripControls(text), this.#o.secrets ?? []));
  }

  #dispatch(command: "PRIVMSG" | "NOTICE", channel: string, text: string): void {
    try {
      this.#o.client.dispatch({ command, params: [channel, text] });
    } catch (err) {
      this.#o.logger.error("dispatch failed; line dropped", {
        nick: this.#o.nick,
        channel,
        command,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** One colored PRIVMSG per line, in order; a failing dispatch drops only that line. */
  say(channel: string, text: string): void {
    const budget = budgetFor(this.#prefix(), channel);
    for (const line of formatLines(this.#clean(text), this.#o.color, budget)) {
      this.#dispatch("PRIVMSG", channel, line);
    }
  }

  /** Sets AWAY (clamped to 200 bytes) and sends one channel NOTICE with the summary. */
  toolStarted(channel: string, summary: string): void {
    const away = truncateBytes(this.#clean(summary), AWAY_MAX_BYTES);
    if (away !== "") {
      try {
        this.#o.client.setAway(away);
      } catch (err) {
        this.#o.logger.error("setAway failed", {
          nick: this.#o.nick,
          cause: err instanceof Error ? err.message : String(err),
        });
      }
      this.#o.snapshot?.setAway(this.#o.nick, away);
    }
    this.channelNotice(channel, summary);
  }

  clearAway(): void {
    try {
      this.#o.client.setAway();
    } catch (err) {
      this.#o.logger.error("clearing away failed", {
        nick: this.#o.nick,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
    this.#o.snapshot?.setAway(this.#o.nick, undefined);
  }

  /** NOTICE to the channel from the agent's virtual client, truncated to the line budget. */
  channelNotice(channel: string, text: string): void {
    const budget = budgetFor(this.#prefix(), channel);
    const body = truncateBytes(this.#clean(text), budget);
    if (body.trim() === "") return;
    this.#dispatch("NOTICE", channel, body);
  }
}

/**
 * One server-prefixed NOTICE per Human_Op of `channel`, delivered with
 * `IrcHost.noticeTo`. `humanOpNicks` returns the `+o` members that are not
 * registered Agent nicks. Returns the number of operators reached.
 */
export function opNotice(
  host: IrcHost,
  logger: RunnerLogger,
  humanOpNicks: (channel: string) => readonly string[],
  channel: string,
  text: string,
): number {
  const body = truncateBytes(text, 400);
  if (body.trim() === "") return 0;
  let reached = 0;
  for (const nick of humanOpNicks(channel)) {
    try {
      if (host.noticeTo(nick, body)) reached += 1;
    } catch (err) {
      logger.error("opNotice failed", {
        channel,
        nick,
        cause: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return reached;
}
