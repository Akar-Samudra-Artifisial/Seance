// Frame_01 "01 Main — #fix-bug-123" (Figma 1:1093) as IRC lines (web-client-pixel-match R13).
// Chat rows follow nodes 1:1352 to 1:1379 and render with the Frame_01 wording. The `-tool-` rows
// are agent tool notices from `coder` (`using tool: …`, shown as `-tool- …`); `-ChanServ-` rows are
// notices from ChanServ (R13.2).
// Pure data: no I/O. Used by the fixture page and by unit tests.

/** Marker the bundle test looks for: present in the e2e build only (R13.6). */
export const FIXTURE_MARKER = "SEANCE_FIXTURE_01_MAIN";

export interface FixtureStep {
  /** Clock time (UTC) when the line arrives, `HH:MM:SS` on 2026-11-06. */
  readonly at: string;
  /** One raw IRC line, without CRLF. */
  readonly line: string;
}

export interface FixtureScript {
  readonly nick: string;
  readonly serverUrl: string;
  readonly channel: string;
  readonly steps: readonly FixtureStep[];
  /** Window keys minimised after the script ran. */
  readonly minimised: readonly string[];
  /** Window key that is active at the end. */
  readonly active: string;
  /** Lag shown in the status bar, seconds. */
  readonly lagSeconds: number;
  /** Unsent text in the input line ("" for none). */
  readonly inputDraft: string;
}

const CH = "#fix-bug-123";
const SRV = "seance.local";
const ME = "bayu!bayu@seance.local";
const CODER = "coder!agent@kiro";
const REVIEWER = "reviewer!agent@kiro";
const RESEARCHER = "researcher!agent@kiro";
const CHANSERV = "ChanServ!services@seance.local";

export const FIGMA_01_MAIN: FixtureScript = {
  nick: "bayu",
  serverUrl: `wss://${SRV}:6697`,
  channel: CH,
  steps: [
    { at: "23:38:00", line: `:${SRV} 001 bayu :Welcome to Séance, bayu` },
    // Credits arrive while Status is still active, so the reply stays in Status (42.7 total).
    { at: "23:38:01", line: `:${SRV} 320 bayu coder :credits: ${CH} 42.70 / total 42.70` },
    { at: "23:38:02", line: `:${ME} JOIN ${CH}` },
    { at: "23:38:02", line: `:${SRV} 353 bayu = ${CH} :@bayu` },
    { at: "23:38:02", line: `:${SRV} 366 bayu ${CH} :End of /NAMES list.` },
    { at: "23:38:05", line: `:${CHANSERV} NOTICE ${CH} :worktree ready: .seance/wt/fix-bug-123 @ a1b2c3d` },
    { at: "23:38:20", line: `:${ME} TOPIC ${CH} :Fix NPE on login when email is null` },
    { at: "23:38:30", line: `:${ME} MODE ${CH} +mnt` },
    { at: "23:39:00", line: `:${SRV} 341 bayu coder ${CH}` },
    { at: "23:39:05", line: `:${CODER} JOIN ${CH}` },
    { at: "23:39:10", line: `:${ME} MODE ${CH} +v coder` },
    { at: "23:40:00", line: `:${CODER} PRIVMSG ${CH} :Plan: guard null email in src/auth/login.ts, add test` },
    { at: "23:40:10", line: `:${CODER} PRIVMSG ${CH} :1) early-return 400 when email is missing, 2) login.spec.ts case` },
    { at: "23:41:00", line: `:${ME} PRIVMSG ${CH} :go ahead` },
    { at: "23:41:05", line: `:${ME} MODE ${CH} +o coder` },
    // Away at 23:41:12, back at 23:43:00: "gone 00:01:48" as in node 1:1368.
    { at: "23:41:12", line: `:${CODER} AWAY :editing src/auth/login.ts` },
    { at: "23:41:20", line: `:${CODER} NOTICE ${CH} :using tool: fs.read src/auth/login.ts · 142 lines · 0.3 cr` },
    { at: "23:42:00", line: `:${CODER} NOTICE ${CH} :using tool: fs.write src/auth/login.ts · +11 −2 · 0.9 cr` },
    { at: "23:42:30", line: `:${CODER} NOTICE ${CH} :using tool: shell: npm test -- login.spec · 14 passed · 1.4 cr` },
    { at: "23:43:00", line: `:${CODER} AWAY` },
    { at: "23:43:10", line: `:${CODER} NOTICE ${CH} :diff ready: 2 files, +18 −3 · /diff coder to view` },
    { at: "23:43:20", line: `:${SRV} 341 bayu reviewer ${CH}` },
    { at: "23:43:30", line: `:${REVIEWER} JOIN ${CH}` },
    { at: "23:44:00", line: `:${REVIEWER} PRIVMSG ${CH} :LGTM, but add a case for empty string` },
    { at: "23:44:30", line: `:${RESEARCHER} JOIN ${CH}` },
    {
      at: "23:45:00",
      line: `:${RESEARCHER} PRIVMSG ${CH} :fyi: RFC 5321 allows quoted local parts, keep validation loose`,
    },
    { at: "23:45:30", line: `:${RESEARCHER} AWAY :reading docs` },
    { at: "23:46:00", line: `:${CODER} PRIVMSG ${CH} :bayu: should whitespace-only " " be rejected too?` },
    { at: "23:46:30", line: `:${ME} PRIVMSG ${CH} :yes. trim, then reject` },
    { at: "23:47:00", line: `:${CODER} PRIVMSG ${CH} :while I'm here I'll also migrate auth/ to the new session API` },
    { at: "23:47:10", line: `:${CHANSERV} NOTICE ${CH} :coder touched 6 files outside topic scope` },
    // Frame_01 shows +reviewer without a MODE row: the voice comes in silently with a NAMES merge.
    { at: "23:47:10", line: `:${SRV} 353 bayu = ${CH} :@bayu @+coder +reviewer researcher` },
    // The other windows of the switchbar: #landing-page (unread) and the coder query.
    { at: "23:47:20", line: `:${ME} JOIN #landing-page` },
    { at: "23:47:20", line: `:${SRV} 353 bayu = #landing-page :@bayu` },
    { at: "23:47:20", line: `:${SRV} 366 bayu #landing-page :End of /NAMES list.` },
  ],
  minimised: ["status"],
  active: `c:${CH}`,
  lagSeconds: 0.12,
  inputDraft: "/kick coder scope creep",
};

/** Steps run after the channel is active again, so #landing-page turns unread. */
export const FIGMA_01_AFTER: readonly FixtureStep[] = [
  { at: "23:47:30", line: `:${RESEARCHER} PRIVMSG #landing-page :hero copy draft is up` },
];

/** Epoch ms of a step time on 2026-11-06 (UTC). */
export function stepTime(at: string): number {
  const m = /^(\d\d):(\d\d):(\d\d)$/.exec(at);
  if (m === null) throw new Error(`fixture step time "${at}" is not HH:MM:SS`);
  return Date.UTC(2026, 10, 6, Number(m[1]), Number(m[2]), Number(m[3]));
}
