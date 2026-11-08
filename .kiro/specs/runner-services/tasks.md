# Implementation Plan: runner-services

## Overview

Bottom-up: the pure service nick helper, then the Ircd (reserved nicks, delivery, registration event), then the runner facts (reset report, short sha, status function), the pure formatters, the wiring, the web routing, the integration tests and the docs. Each property test carries its design ID (`P1` to `P7`) in its name. Group 12 (agent loop guard, Requirement 11) was added on 2026-11-08 and is done before the docs of group 10. Verify per package (`pnpm --filter <pkg> typecheck`, `pnpm --filter <pkg> test`) because root turbo runs may time out here; rebuild the runner (`pnpm --filter @seance/runner build`) before running ircd tests that import `@seance/runner`. Never delete a test to make it pass. Fixing a bug starts with a failing test. No Postgres, Redis or new dependency. Integration tests reuse the helpers in `apps/ircd/test/runner/integration.ts` (`startIntegration`, `ManualClock`, `closeAllFixtures`, `FAKE_KIRO_BIN`) and follow the pattern of `apps/ircd/test/runner/exorcism.integration.test.ts`. Tasks stay coding-only.

## Tasks

- [x] 1. Service nick helper in `@seance/irc-protocol`
  - [x] 1.1 Add `src/services.ts` with `SERVICE_NICKS`, `ServiceNick`, `isServiceNick`; export from `index.ts`
    - Pure, no I/O, runs in the browser
    - `packages/irc-protocol/src/index.ts` exports `SERVICE_NICKS`, `ServiceNick` and `isServiceNick`
    - _Requirements: 1.1_
  - [x] 1.2 Write unit and property tests
    - **Property 4: Reservation** (`P4 service nick case variants`): every case and rfc1459 bracket variant is a service nick, other valid nicks are not
    - _Requirements: 1.1_

- [x] 2. Ircd: reserved nicks, delivery, registration event
  - [x] 2.1 Reject service nicks in `handleNick`
    - `432` with `Nickname is reserved for network services`; keep the old nick; applies to TCP, WS and virtual clients
    - Test first: a failing test for `NICK chanserv`, `NICK NickServ`, `NICK [hanserv`-style variants and a nick change by a registered client
    - _Requirements: 1.2, 1.3_
  - [x] 2.2 Add `src/services.ts` and `IrcServer.services`
    - Channel and nick targets, mode bypass, control stripping, 512-byte clamp
    - `IrcServer` in `apps/ircd/src/server.ts` gets the readonly `services` member (interface and implementation)
    - A failing delivery is caught and logged with service, target and cause
    - No `irc.message` publication
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6_
  - [x] 2.3 Publish `irc.register`
    - New `EventMap` entry; published last in `onRegistrationComplete`; none on a rejected registration (`464`)
    - _Requirements: 3.1, 3.2, 3.3_
  - [x] 2.4 Write the Ircd tests in `apps/ircd/test/services.test.ts`
    - `401` for `WHOIS ChanServ` and `PRIVMSG NickServ`; channel and nick delivery; `+m` channel; no `irc.message` (bus spy); overlong text; one `irc.register` per registration, with `virtual` set for agents
    - Ircd half of Property 4 (`P4 reserved nick never registers`): `NICK` with any case or rfc1459 bracket variant of a service nick never registers a client and keeps the old nick
    - _Requirements: 1.1 to 1.3, 1.5, 2.1 to 2.4, 3.1 to 3.3, 9.2_
  - [x] 2.5 Adapt the port in `runner-wiring.ts`
    - `serviceNotice` and the `irc.register` event type; the return annotation keeps port drift a typecheck error
    - _Requirements: 2.5_

- [x] 3. Checkpoint: `pnpm --filter @seance/irc-protocol test`, `pnpm --filter @seance/ircd typecheck`, `pnpm --filter @seance/ircd test`

- [x] 4. Runner facts
  - [x] 4.1 Reject service nicks in `parseProfile`
    - `AgentProfileError` names file and `nick`; add a case to `registry.test.ts`
    - _Requirements: 1.4_
  - [x] 4.2 Export `agentStatus` from `whois/render.ts`
    - `renderWhois` output must not change (existing whois tests stay green)
    - _Requirements: 4.2_
  - [x] 4.3 `WorktreeManager.shortHead` and `reset` returning `ResetReport`
    - Count Dirty_Files with `status --porcelain=v1 -z --untracked-files=all --no-renames` before the reset; `target` is the short sha of the reset target (HEAD, or the base when committed hits are discarded)
    - Tests in `worktree.test.ts`: clean tree gives 0, modified plus untracked files are counted, base reset reports the base sha
    - _Requirements: 5.1, 6.2, 6.3_

- [x] 5. Notice formatters
  - [x] 5.1 Add `src/services/notices.ts` (pure)
    - `worktreeReady`, `sessionEnded`, `filesReverted`, `agentsOnline`, `worktreeNoticeDir`, `CREDITS_WORD`, `NOTICE_MAX_BYTES`
    - Strip controls, cut at code point boundaries, singular for one file, `undefined` when files and credits are both zero
    - _Requirements: 4.2, 5.1, 6.1, 6.3, 7.4_
  - [x] 5.2 Write unit tests `services-notices.test.ts`
    - Mockup shapes with two decimals; singular and plural; zero case; control characters; the forbidden trademark term never appears (built from two fragments)
    - _Requirements: 9.1, 9.5_
  - [x] 5.3 Write property tests
    - **Property 1: Notice bounds** (`P1 notice bounds`)
    - **Property 2: Roster is exact** (`P2 roster is exact`)
    - **Property 3: Credits agree with WHOIS** (`P3 credits agree with whois`)
    - _Requirements: 4.2, 4.4, 6.3, 7.3, 9.1_

- [x] 6. Wiring in the runner
  - [x] 6.1 Extend `ports.ts` and add `src/services/services.ts`
    - `ServiceName`, `serviceNotice`, `irc.register`; `createServices` wraps the host, logs failures, never throws
    - `apps/runner/src/index.ts` exports the new types `ServiceName` (and `ResetReport` from the worktree manager) so apps/ircd can import them from `@seance/runner`
    - _Requirements: 2.5, 2.6_
  - [x] 6.2 `worktree ready` in the invite pipeline
    - Only when `info.created`; skip and log when `shortHead` fails; optional dep so existing tests stay valid
    - _Requirements: 5.1 to 5.5_
  - [x] 6.3 Unit test for the invite path in `apps/runner/test/invite-services.test.ts` with a fake WorktreeManager
    - `worktree ready` once when `created` is true, none when it is false, none when `shortHead` returns undefined, none when `ensure` rejects
    - _Requirements: 5.1 to 5.5_
  - [x] 6.4 Session end notices in the exorcist
    - Capture `wasPrompting` first; send after a successful reset, only for `kick` and `part`; second line via `creditsOf`
    - Unit tests in `apps/runner/test/exorcism.test.ts` with fake deps: notices sent after a successful reset for `kick` and `part`; none for `quit`; none when `reset` rejects; the first line says `cancelled` only when the session was `prompting` at the start; the second line is absent when files and credits are both zero
    - _Requirements: 6.1 to 6.6_
  - [x] 6.5 NickServ roster in `runner.ts`
    - Subscribe to `irc.register`; ignore virtual clients and shutdown; read statuses from the Snapshot
    - _Requirements: 4.1, 4.3, 4.4_
  - [x] 6.6 Write **Property 5: Gating** (`P5 notices only when true`)
    - Model-based over random invite and kick sequences with a fake worktree manager
    - _Requirements: 5.1, 5.2, 5.5, 6.4, 6.5, 7.1_

- [x] 7. Checkpoint: `pnpm --filter @seance/runner typecheck`, `pnpm --filter @seance/runner test`, `pnpm --filter @seance/runner build`

- [x] 8. Web routing
  - [x] 8.1 Route service notices to Status in `reducer.ts`
    - `isServiceNick` from `@seance/irc-protocol`; no query window; channel path unchanged
    - Test first: NickServ notice to the own nick currently opens a query window
    - _Requirements: 8.1 to 8.4_
  - [x] 8.2 Write tests
    - **Property 6: Web routing** (`P6 service notice never opens a query`)
    - One `ChatLine` render test: `-ChanServ- text` in a channel, `-NickServ- text` in Status; a `PRIVMSG` from a service keeps the old behaviour
    - _Requirements: 8.1 to 8.4, 9.4_

- [x] 9. Integration with the Fake_Agent
  - [x] 9.1 Add `apps/ircd/test/runner/services.integration.test.ts`
    - Use `startIntegration({ clock, script, env })` with a `ManualClock`, `fx.connectClient(...)`, and `closeAllFixtures()` in `afterEach`, as `exorcism.integration.test.ts` does; port 0, no wall-clock sleeps
    - A turn that stays in flight uses the Fake_Agent step `{ gate: "hold" }`; credits come from a `{ metadata: { credits: [...] } }` step. The Fake_Agent cannot write files, so the test itself writes three files into the channel worktree directory before the kick
    - Cases: `worktree ready` exactly once for two invites into one channel, with the short sha of the temp repo (`git rev-parse --short=7 HEAD`); `agents online` for a human after boot lists the registry in `idle`, then `coder (prompting)` while a turn is held; kick during a held turn gives `session cancelled, worktree reset to <sha>`; kick when idle gives `session closed, worktree reset to <sha>`; `3 files reverted`; the credits in the notice equal the `320` line of `/WHOIS coder`; no notice contains "restored"; no NickServ notice when `SEANCE_RUNNER` is off
    - _Requirements: 4.1 to 4.4, 5.1, 5.2, 6.1 to 6.6, 7.2, 7.3, 9.3_
  - [x] 9.2 Run the ircd runner integration suite after `pnpm --filter @seance/runner build`

- [x] 12. Agent-to-agent loop guard (Requirement 11, added 2026-11-08)
  - [x] 12.1 Add `apps/runner/src/session/agent-loop-guard.ts` (pure): `AGENT_REPLY_LIMIT`, `mentionsNick`, `AgentLoopGuard`
    - Test first: a unit test that two Agents answering each other are prompted without bound today
    - _Requirements: 11.1, 11.3 to 11.5_
  - [x] 12.2 Write **Property 7: Agent loop guard** (`P7 agent loop guard`) against a reference model
    - _Requirements: 11.1, 11.3 to 11.5_
  - [x] 12.3 Use the guard in `SessionManager.onChannelMessage` before `#prompt` and `#revive`; reset on human lines; clear on shutdown; log once per limit episode
    - Unit tests with the fake harness: not-mentioned drop, limit after 3, reset by a human line, NOTICE and private PRIVMSG from an Agent never prompt
    - _Requirements: 11.1 to 11.6_
  - [x] 12.4 Integration test `apps/ircd/test/runner/agent-loop.integration.test.ts` with two `+v` Fake_Agents
    - `ok` / `ok` without mentions stops after the first round; mutual mentions stop after 3 replies each; a new human line allows one more bounded round
    - _Requirements: 11.7_

- [x] 10. Docs and naming
  - [x] 10.1 Update `DESIGN.md`
    - Services section with the six texts, the reserved nicks, D4 to D6; fix the Kiro agent list entry `chanserv`; keep the table row for services
    - _Requirements: 10.1_
  - [x] 10.2 Update `README.md` runner section
    - One paragraph: reserved nicks and the notices; no new environment variable
    - _Requirements: 10.1_
  - [x] 10.3 Add a test-free check: run a case-insensitive search for the trademarked term (built from two fragments) over the changed files and the spec files; expect no hits
    - _Requirements: 10.2_

- [x] 11. Final checkpoint
  - Run `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test --force` (or per package), and `pnpm test:e2e` in `apps/web`

## Notes

- Every test sub-task is a required step in this plan; each design property P1 to P6 has its own property test sub-task or is named inside a test sub-task (P4 appears in 1.2 and 2.4).
- Task 2.5 adapts the runner's `IrcHost` port, which task 6.1 extends. Do the `ports.ts` change of 6.1 first, rebuild the runner (`pnpm --filter @seance/runner build`), then do 2.5; the ircd imports `@seance/runner` from `dist`.
- The two Open Points of `design.md` (credits wording, restored sessions) are decided in the tasks as written: the word is `used` (one constant), and no restored-sessions line is built.
- Root `pnpm typecheck` and `pnpm test` may time out under turbo; per-package runs are acceptable.
- Tests use `ManualClock` or fake timers, bind sockets to port 0 and close everything in `afterEach`. Temporary git repositories come from `apps/runner/test/fixtures/temp-repo.ts` and are removed in `finally`.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.2", "2.3", "4.2", "4.3", "6.1"] },
    { "id": 1, "tasks": ["1.2", "2.1", "2.5", "4.1", "5.1", "8.1"] },
    { "id": 2, "tasks": ["2.4", "5.2", "5.3", "6.2", "6.4", "6.5", "8.2"] },
    { "id": 3, "tasks": ["6.3", "6.6"] },
    { "id": 4, "tasks": ["9.1"] },
    { "id": 5, "tasks": ["9.2", "10.1", "10.2"] },
    { "id": 6, "tasks": ["10.3"] },
    { "id": 7, "tasks": ["12.1"] },
    { "id": 8, "tasks": ["12.2", "12.3"] },
    { "id": 9, "tasks": ["12.4"] }
  ]
}
```
