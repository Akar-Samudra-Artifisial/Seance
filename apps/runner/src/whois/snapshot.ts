import { irc_lower } from "@seance/irc-protocol";

import type { SessionState } from "../session/machine.js";

/** Per-channel record of one Agent. `name` keeps the original spelling for display. */
export type ChannelSnapshot = {
  readonly name: string;
  readonly state: SessionState;
  readonly credits: number;
};

/**
 * Read view of one Agent's entry (Requirement 10.17). `model` and `tools` are
 * absent until `register` runs, so a partial entry is possible (Requirement 10.19).
 */
export type AgentSnapshot = {
  readonly model?: string;
  readonly tools?: string;
  /** agent-skills Req 3: skill names from the profile; empty or absent means no `skills:` line. */
  readonly skills?: readonly string[];
  readonly away?: string;
  /** Keyed by `irc_lower(channel)`. Closed channels stay listed; renderers filter them. */
  readonly channels: ReadonlyMap<string, ChannelSnapshot>;
  /** Sum of `credits` over all channels of the Agent. */
  readonly total: number;
};

type MutableEntry = {
  model?: string;
  tools?: string;
  skills?: readonly string[];
  away?: string;
  channels: Map<string, ChannelSnapshot>;
  total: number;
};

/**
 * In-memory Whois_Snapshot. Every setter is synchronous and performs no I/O,
 * so the entry is current before the next event for the Agent is processed.
 * Written by `Session` and `CreditLedger`, read only by `renderWhois`.
 */
export class WhoisSnapshot {
  readonly #entries = new Map<string, MutableEntry>();

  /** Sets the static profile fields; creates the entry if needed. */
  register(
    nick: string,
    profile: { readonly model: string; readonly tools: string; readonly skills?: readonly string[] | undefined },
  ): void {
    const entry = this.#ensure(nick);
    entry.model = profile.model;
    entry.tools = profile.tools;
    // A copy: the snapshot never shares an array with the registry.
    entry.skills = [...(profile.skills ?? [])];
  }

  setState(nick: string, channel: string, state: SessionState): void {
    const entry = this.#ensure(nick);
    const key = irc_lower(channel);
    const prev = entry.channels.get(key);
    entry.channels.set(key, { name: prev?.name ?? channel, state, credits: prev?.credits ?? 0 });
  }

  /** `credits` must be a finite number >= 0; anything else throws and changes nothing. */
  setCredits(nick: string, channel: string, credits: number): void {
    if (!Number.isFinite(credits) || credits < 0) {
      throw new RangeError(`setCredits: credits must be a finite number >= 0, got ${String(credits)}`);
    }
    const entry = this.#ensure(nick);
    const key = irc_lower(channel);
    const prev = entry.channels.get(key);
    entry.channels.set(key, { name: prev?.name ?? channel, state: prev?.state ?? "closed", credits });
    entry.total = sumCredits(entry.channels);
  }

  /** `undefined` clears the away text. */
  setAway(nick: string, away: string | undefined): void {
    const entry = this.#ensure(nick);
    if (away === undefined) {
      delete entry.away;
    } else {
      entry.away = away;
    }
  }

  get(nick: string): AgentSnapshot | undefined {
    return this.#entries.get(irc_lower(nick));
  }

  /** Drops the entry for a nick (used at shutdown). */
  delete(nick: string): void {
    this.#entries.delete(irc_lower(nick));
  }

  #ensure(nick: string): MutableEntry {
    const key = irc_lower(nick);
    let entry = this.#entries.get(key);
    if (entry === undefined) {
      entry = { channels: new Map(), total: 0 };
      this.#entries.set(key, entry);
    }
    return entry;
  }
}

function sumCredits(channels: ReadonlyMap<string, ChannelSnapshot>): number {
  let total = 0;
  for (const c of channels.values()) total += c.credits;
  return total;
}
