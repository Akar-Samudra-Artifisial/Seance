// public-hardening Requirement 5.1: the credit ledger survives a restart. One JSON file in the
// workspaces root, written atomically (temp file in the same directory, then rename, mode 0600).
import { readFileSync } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { irc_lower } from "@seance/irc-protocol";
import type { SessionState } from "../session/machine.js";
import type { SessionRecord, SessionStore } from "../session/session-store.js";
import type { DailyState } from "./budget.js";

export const CREDITS_FILE_NAME = ".seance-credits.json";

const STATES: ReadonlySet<string> = new Set<SessionState>([
  "idle",
  "prompting",
  "cancelling",
  "cooldown",
  "closed",
] as SessionState[]);

/** Thrown when the file exists but cannot be used; the runner must not start (it would lose credits). */
export class CreditsFileError extends Error {
  constructor(path: string, reason: string) {
    super(`credits file ${path} cannot be used: ${reason}`);
    this.name = "CreditsFileError";
  }
}

type FileShape = {
  readonly version: 1;
  readonly sessions: readonly SessionRecord[];
  readonly daily?: DailyState;
};

const key = (agent: string, channel: string): string => `${irc_lower(agent)}\0${irc_lower(channel)}`;

function parseRecord(v: unknown): SessionRecord | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  const { agent, channel, acpSessionId, status, creditsUsed, updatedAt } = r;
  if (typeof agent !== "string" || typeof channel !== "string") return undefined;
  if (typeof status !== "string" || !STATES.has(status)) return undefined;
  if (typeof creditsUsed !== "number" || !Number.isFinite(creditsUsed) || creditsUsed < 0) return undefined;
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return undefined;
  if (acpSessionId !== undefined && acpSessionId !== null && typeof acpSessionId !== "string") return undefined;
  return {
    agent: irc_lower(agent),
    channel: irc_lower(channel),
    acpSessionId: typeof acpSessionId === "string" ? acpSessionId : undefined,
    status: status as SessionState,
    creditsUsed,
    updatedAt,
  };
}

/**
 * A `SessionStore` backed by `<dir>/.seance-credits.json`, plus the daily budget state. Reads once
 * at construction (synchronously, before any invite); every change rewrites the whole file, one
 * write at a time.
 */
export class CreditsFile implements SessionStore {
  readonly path: string;
  readonly #records = new Map<string, SessionRecord>();
  #daily: DailyState | undefined;
  #chain: Promise<void> = Promise.resolve();
  #seq = 0;

  /**
   * `onSkip` hears about each unusable session record or daily state (Requirement 16.3); they are
   * left out, never silently.
   */
  constructor(dir: string, onSkip?: (what: string, reason: string) => void) {
    this.path = join(dir, CREDITS_FILE_NAME);
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new CreditsFileError(this.path, (err as Error).message);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new CreditsFileError(this.path, "not valid JSON");
    }
    const shape = json as Partial<FileShape> | null;
    if (shape === null || typeof shape !== "object" || shape.version !== 1 || !Array.isArray(shape.sessions)) {
      throw new CreditsFileError(this.path, "unknown format (expected version 1)");
    }
    shape.sessions.forEach((raw, i) => {
      const record = parseRecord(raw);
      if (record !== undefined) this.#records.set(key(record.agent, record.channel), record);
      else onSkip?.(`session record ${i}`, "invalid fields");
    });
    const d = shape.daily;
    if (d !== undefined && typeof d.day === "string" && typeof d.credits === "number" && Number.isFinite(d.credits) && d.credits >= 0) {
      this.#daily = { day: d.day, credits: d.credits };
    } else if (d !== undefined) {
      onSkip?.("daily state", "invalid fields");
    }
  }

  get(agent: string, channel: string): Promise<SessionRecord | undefined> {
    return Promise.resolve(this.#records.get(key(agent, channel)));
  }

  list(): Promise<readonly SessionRecord[]> {
    return Promise.resolve([...this.#records.values()]);
  }

  put(record: SessionRecord): Promise<void> {
    this.#records.set(key(record.agent, record.channel), record);
    return this.#write();
  }

  /** The daily budget state read at start, if any. */
  daily(): DailyState | undefined {
    return this.#daily;
  }

  putDaily(state: DailyState): Promise<void> {
    this.#daily = state;
    return this.#write();
  }

  /** Waits for pending writes (shutdown, tests). */
  flush(): Promise<void> {
    return this.#chain;
  }

  #write(): Promise<void> {
    const run = async (): Promise<void> => {
      const body: FileShape = {
        version: 1,
        sessions: [...this.#records.values()],
        ...(this.#daily !== undefined ? { daily: this.#daily } : {}),
      };
      this.#seq += 1;
      const tmp = `${this.path}.tmp-${process.pid}-${this.#seq}`;
      try {
        // public-hardening Requirement 16.1: the bytes reach the disk before the rename makes
        // them the file, so a crash cannot leave an empty or partial credits file.
        const handle = await open(tmp, "w", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(body)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(tmp, this.path);
      } catch (err) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw err;
      }
    };
    const next = this.#chain.then(run, run);
    this.#chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
