# Implementation Plan: public-hardening

## Overview

ircd first (accounts, registration, client address, guard), then the runner (inviters, gating, credits, redaction, git), then docs and the full checks. Each property test carries its design ID (`P1` to `P3`). Verify per package, then run the full suite with `--concurrency=1` (parallel turbo runs time out on this machine). No existing test is deleted or weakened. The real `kiro-cli` is never used.

## Tasks

- [x] 1. Accounts and authentication (ircd)
  - [x] 1.1 `apps/ircd/src/accounts.ts`: parse, permission check, scrypt verify (async), `hashSecret`; `tools/seance-account.mjs`
    - _Requirements: 2.1, 2.2, 2.6, 2.7_
  - [x] 1.2 Config: `IRCD_ACCOUNTS_FILE`, `IRCD_TRUSTED_PROXIES`, `IRCD_MAX_CONNECTIONS_PER_IP`, `IRCD_MAX_PASS_FAILURES_PER_IP`; registration timeout default 15 s
    - _Requirements: 1.3, 7.1 to 7.3_
  - [x] 1.3 Registration in Auth_Mode: deferred claim, guest and account login, reserved nicks, three strikes, virtual exemption, fixed account nick
    - _Requirements: 1.1, 1.2, 1.4, 1.5, 2.3 to 2.5_
  - [x] 1.4 Tests: registration and accounts unit tests; **Property 1: Reserved nicks stay reserved** (`P1 ...`)
    - **Validates: Requirements 1, 2**

- [x] 2. Client address and per-IP limits (ircd)
  - [x] 2.1 `client-ip.ts`, `PerIpGate`, `PassFailures`; wire into both transports
    - _Requirements: 7.1 to 7.3_
  - [x] 2.2 Tests, including **Property 3: Client IP** (`P3 ...`)
    - **Validates: Requirements 7**

- [x] 3. Host port and inviters (ircd + runner)
  - [x] 3.1 `IrcHost.accountsEnabled`, `accountOf`, `isAccount`; `ServerOptions.reservedNicks`; wiring in `index.ts`
    - _Requirements: 2.4, 3.1_
  - [x] 3.2 `parseInviters` with auth; start check of `SEANCE_INVITERS` against accounts; `!reset-credits` needs an Inviter
    - _Requirements: 3.1 to 3.3_
  - [x] 3.3 Tests
    - **Validates: Requirements 3**

- [x] 4. Prompt gating (runner)
  - [x] 4.1 Record the inviter per (agent, channel); gate `onChannelMessage`
    - _Requirements: 4.1_
  - [x] 4.2 Tests
    - **Validates: Requirements 4.1**

- [x] 5. Credits, budget and caps (runner)
  - [x] 5.1 `CreditsFile` store (atomic), default in `createRunner`
    - _Requirements: 5.1_
  - [x] 5.2 `DailyBudget`, ledger integration, ChanServ notice, kill switch, `isBlocked` for channel and private sessions, WHOIS `budget:`
    - _Requirements: 5.2 to 5.4_
  - [x] 5.3 `SEANCE_MAX_AGENT_CHANNELS`, `SEANCE_MAX_CONTAINERS` in the invite path
    - _Requirements: 5.5_
  - [x] 5.4 Tests (unit and fake-agent integration)
    - **Validates: Requirements 5**

- [x] 6. Token exfiltration (runner)
  - [x] 6.1 `SecretRedactor` with variants, fragments and turn tails; use it in `AgentOutput`
    - _Requirements: 6.2_
  - [x] 6.2 Read secrets from `SEANCE_SANDBOX_AUTH_DIR` at start (podman mode)
    - _Requirements: 6.1_
  - [x] 6.3 Refuse tool paths and shell commands touching the auth mount or the staged login
    - _Requirements: 6.3_
  - [x] 6.4 Tests, including **Property 2: Redaction removes every variant and fragment** (`P2 ...`)
    - **Validates: Requirements 6.1 to 6.3**

- [x] 7. Public guard (ircd + runner)
  - [x] 7.1 Extend `checkPublicStartup` and add `assertPublicRunner`; list every failing variable
    - _Requirements: 8.1 to 8.3_
  - [x] 7.2 Tests
    - **Validates: Requirements 8**

- [x] 8. Bounded host git (runner)
  - [x] 8.1 Timeouts in `runGit` and `createGitRunner`; `SEANCE_GIT_TIMEOUT_MS`
    - _Requirements: 9.1_
  - [x] 8.2 Worktree size cap and reset on failure in `commitTurn`; report from the committer
    - _Requirements: 9.2_
  - [x] 8.3 Tests
    - **Validates: Requirements 9**

- [x] 9. Docs and checks
  - [x] 9.1 README (variables, accounts, budget), `docs/SANDBOX.md` (residual token risk, demo account), `DESIGN.md`, `docs/KIRO_USAGE.md`
    - _Requirements: 6.4, 10.3_
  - [x] 9.2 `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm --filter @seance/web test:e2e`
    - _Requirements: 10.1, 10.2_

## Follow-up tasks (review of 2026-11-08)

- [x] 10. Trusted proxies in the public guard
  - [x] 10.1 `checkPublicStartup`: require `IRCD_TRUSTED_PROXIES`, loopback IPs only; `assertPublicRunner` repeats it (`RunnerOptions.trustedProxies`, passed by `index.ts`)
    - _Requirements: 11.1, 11.2_
  - [x] 10.2 Tests in `public-guard.test.ts` and the runner; README and `docs/DEPLOY.md`
    - **Validates: Requirements 11**

- [x] 11. Private sessions in the budget
  - [x] 11.1 `CreditLedger.recordPrivateMetering` (daily budget only); metering in `#openPrivate`; `SessionManager.allSessions()` for the daily-cap cancel
    - _Requirements: 12.1, 12.2_
  - [x] 11.2 Container cap for private opens (`privateCapacity`) and for `reviveSession` (in-flight revivals and pending starts counted)
    - _Requirements: 12.3_
  - [x] 11.3 Tests
    - **Validates: Requirements 12**

- [x] 12. Worktree size during a Turn
  - [x] 12.1 `tool-done` session event from `tool_call_update`; `WorktreeManager.exceedsCap`; cancel and reset in `buildChannelSession`
    - _Requirements: 14.1_
  - [x] 12.2 `reset(channel, { ignored: true })` (`git clean -fdx`) on the size and timeout paths; `docs/DEPLOY.md` disk quota note
    - _Requirements: 14.2, 14.3_
  - [x] 12.3 Tests
    - **Validates: Requirements 14**

- [x] 13. Commands during an account login
  - [x] 13.1 Hold up to 20 lines while the login is pending, replay after `001`, `451` past the limit or after a failed login
    - _Requirements: 13.1, 13.2_
  - [x] 13.2 Tests, including a pipelined `PASS`/`NICK`/`USER`/`JOIN` that joins the channel
    - **Validates: Requirements 13**

- [x] 14. `docs/SANDBOX.md`: the login is readable and egress allows uploads; dedicated demo account; known redactor bypasses
  - _Requirements: 15.1, 15.2_

- [x] 15. Credits file robustness and final checks
  - [x] 15.1 fsync before rename; coalesced daily writes; skipped entries logged
    - _Requirements: 16.1 to 16.3_
  - [x] 15.2 Tests; `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm --filter @seance/web test:e2e`; `docs/KIRO_USAGE.md`
    - _Requirements: 10.1, 10.2_

- [x] 16. Security re-check fixes (each with a test)
  - [x] 16.1 `exceedsBytes`: skip ENOENT per entry, any other error counts as over the cap; a failed check in the session watcher is over the cap too
    - _Requirements: 14.1_
  - [x] 16.2 Size watcher: a tool-done during a running check re-runs it; a late result still resets; a final check at every turn end, for every agent
    - _Requirements: 14.1_
  - [x] 16.3 One canonical address form (`canonicalIp`, loopback `BlockList`) in `client-ip.ts`, `public-guard.ts` and the runner guard
    - _Requirements: 7.1, 11.1, 11.2_
  - [x] 16.4 `privateCount()` counts open private sessions only; a private session leaves `#privates` when it closes, whatever the reason
    - _Requirements: 12.3_
  - [x] 16.5 `docs/DEPLOY.md`: Caddy overwrites `X-Forwarded-For` (Caddyfile snippet); hard disk quota for `SEANCE_WORKSPACES`
    - _Requirements: 14.3_

- [x] 17. Guest login through `<nick>:<server password>` (requirement 1.5a)
  - [x] 17.1 `handleAuthPass`: after the exact server-password check and the account check, accept `<nick>:<server password>` as a Guest instead of a strike; wrong values still strike; tests in `test/public-hardening.test.ts` (plain password, prefixed password with and without accounts, valid account, account secret equal to the server password, wrong value, three wrong closes)
    - _Requirements: 1.4, 1.5a_
  - [x] 17.2 Security review fix (Medium): the fallback no longer costs a scrypt per connection. A nick that is not an account is accepted as a Guest at once (no `verify`); an account nick is verified first, and a failure with the server password records `passFailures` (no strike) before the Guest is accepted; `docs/DEPLOY.md` warns not to reuse the server password as an account secret; tests in `test/public-hardening.test.ts` (no verify for a non-account, one verify and one recorded failure for an account, repeated attempts block the address, right secret, leading colon, colon in the server password, pipelined JOIN, 433 then a free nick releases the held lines)
    - _Requirements: 1.5a_
  - [x] 17.3 Follow-up review fix (Medium): a failed `verify` is recorded in `passFailures` even when the client left while the scrypt ran (the `stillPending` early return no longer skips it), exactly once per attempt: `strike()` still records for a client that stays, the prefixed-guest fallback keeps its single record; a successful verify records nothing; tests in `test/public-hardening.test.ts` (wrong secret and `alice:<serverpw>` followed by a disconnect, the strike path once, a correct secret and a disconnect records nothing, `ALICE:<serverpw>` goes through verify, a blocked address is refused with the server password over TCP)
    - _Requirements: 1.5a, 7.3_

## Notes

- Outside Auth_Mode the ircd behaves as before, so the existing ircd tests run unchanged.
- Agent virtual clients never send `PASS`; Auth_Mode exempts the runner's trusted virtual clients only (`trusted: true`). Untrusted virtual clients are treated like network clients.
- Intended behaviour changes in existing tests (each marked with a comment): prompt gating (Requirement 4) in `apps/runner/test/session-manager.test.ts` (unmoded senders get `+v` or no longer prompt) and `apps/ircd/test/runner/agent-loop.integration.test.ts` (the lurker's line no longer prompts); the public guard (Requirement 8) in `apps/ircd/test/public-guard.test.ts` (accepted public environments carry the new variables).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "5.1", "6.1", "8.1"] },
    { "id": 1, "tasks": ["1.2", "5.2", "6.2", "8.2"] },
    { "id": 2, "tasks": ["1.3", "3.1", "6.3", "5.3"] },
    { "id": 3, "tasks": ["1.4", "2.2", "3.2", "4.1", "6.4", "8.3"] },
    { "id": 4, "tasks": ["3.3", "4.2", "5.4", "7.1"] },
    { "id": 5, "tasks": ["7.2", "9.1"] },
    { "id": 6, "tasks": ["9.2"] },
    { "id": 7, "tasks": ["10.1", "11.1", "12.1", "13.1", "14", "15.1"] },
    { "id": 8, "tasks": ["10.2", "11.2", "12.2", "13.2"] },
    { "id": 9, "tasks": ["11.3", "12.3"] },
    { "id": 10, "tasks": ["15.2"] },
    { "id": 11, "tasks": ["16.1", "16.3", "16.4", "16.5"] },
    { "id": 12, "tasks": ["16.2"] }
  ]
}
```
