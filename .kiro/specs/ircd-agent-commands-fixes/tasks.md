# Implementation Plan: ircd-agent-commands-fixes

## Overview

Bugfix plan for six review findings in `apps/ircd`. Exploration tests come first and must fail on the unfixed code, preservation tests must pass on it, then each finding is fixed in order. Shared helpers are added before their users, and the exploration tests are re-run after the fixes.

## Tasks

- [x] 1. Write bug condition exploration tests (BEFORE any fix)
  - **Property 1: Bug Condition** - Six review findings reproduce on unfixed code
  - **CRITICAL**: These tests MUST FAIL on unfixed code; failure confirms the bugs exist. Do not fix the code or weaken the tests when they fail.
  - Scope each test to the concrete failing case from `design.md` (Regression tests table); keep tests in separate files per finding so later waves do not clash
  - Record the counterexample each test finds (for example "`#a.invited` still holds `bob` after quit")
  - [x] 1.1 Finding 1: invited-set leaks, in `apps/ircd/test/agent-commands-fixes.invited.test.ts`
    - `PART` and `KICK` remove the entry only in that channel; `QUIT` removes it from every channel; `NICK` moves an invited entry and clears the new key in member channels, adds nothing for a non-invited rename; 101 invites leave 100 and re-invite makes the entry newest
    - _Requirements: 1.1, 1.2, 1.3, 1.4_
  - [x] 1.2 Finding 2: WHOIS extra lines, in `apps/ircd/test/agent-commands-fixes.whois.test.ts`
    - `whoisExtra` returning `undefined`, a string, an object, `[1, "a"]`, 25 strings, and a throw after `312`: exactly one `318` last, at most 10 `320`, type logged
    - _Requirements: 1.5, 1.6, 1.7_
  - [x] 1.3 Finding 3: blank AWAY, in `apps/ircd/test/agent-commands-fixes.away.test.ts`
    - `AWAY :   `, tab-only and CR/LF/NUL-only text give `305` and clear `away`; `VirtualClient.setAway("   ")` clears
    - _Requirements: 1.8_
  - [x] 1.4 Finding 4: INVITE event and `301`, in `apps/ircd/test/agent-commands-fixes.invite.test.ts`
    - `irc.invite` carries `targetKey` and `targetOnline` (true for connected, false for resolver claim); accepted invite of an away target gives `341` then one `301`; none for non-away or resolver claim
    - _Requirements: 1.9, 1.10_
  - [x] 1.5 Finding 5: duplicated helpers, in `apps/ircd/test/agent-commands-fixes.helpers.test.ts`
    - Source scan: `away.ts`, `message.ts` and `registration.ts` define no `function numeric` or `function prefixOf` and import from `../replies.js` (same style as `numeric-literals.test.ts`)
    - _Requirements: 1.11_
  - [x] 1.6 Finding 6: socket error levels, in `apps/ircd/test/agent-commands-fixes.socket-errors.test.ts`
    - TCP client calls `resetAndDestroy()`: `error` spy not called, `debug` spy called with the client id; unit cases for `logSocketError` with `ECONNRESET`, `EPIPE` (debug) and `ETIMEDOUT`, no code (error)
    - _Requirements: 1.12_
  - Run on UNFIXED code, confirm every test fails, and document the counterexamples
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 1.11, 1.12_

- [x] 2. Write preservation tests (BEFORE any fix)
  - **Property 2: Preservation** - Behaviour outside the bug conditions is unchanged
  - **IMPORTANT**: Follow observation-first methodology. Observe the unfixed code, then assert what it does. Tests MUST PASS on unfixed code.
  - [x] 2.1 Example tests in `apps/ircd/test/agent-commands-fixes.preservation.test.ts`
    - Join clears only the joiner, last leaver deletes the set, rfc1459 variants share one entry (3.1 to 3.3)
    - Resolver claim: `341`, event, no `INVITE`, entry stays until join; each rejection sends one error, no `301`, no event (3.4, 3.5)
    - Up to 10 valid `whoisExtra` strings give `320` in order between `312` and `301`/`317`, called once; empty array gives none; `401` then `318` for unknown nick; `431` without `318` (3.6, 3.7)
    - Real `AWAY` text stores clamped text and replies `306`; bare `AWAY` gives `305`; unregistered gives `451`; `PRIVMSG` gives one `301`, `NOTICE` none (3.8, 3.10)
    - Non-away target still gets `341` and `INVITE`; old event fields keep their values (3.9)
    - Golden lines for `001` to `005`, `306`, `305` and a relayed `PRIVMSG`/`NOTICE` prefix (3.11)
    - `ETIMEDOUT` error still logs at `error`, destroys the socket and frees the slot (3.12)
    - Non-invited `NICK` change announces once (3.13)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11, 3.12, 3.13_
  - [x] 2.2 Property-based test: **Property 4: Preservation** in `apps/ircd/test/agent-commands-fixes.preservation.property.test.ts`
    - fast-check, at least 100 runs, tag `Feature: ircd-agent-commands-fixes, Property 4: Preservation - Unchanged behaviour outside the bug conditions`
    - For generated valid `whoisExtra` arrays (up to 10 strings), non-blank `AWAY` text, and non-invited `NICK` changes, replies and events equal the observed baseline
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11, 3.12, 3.13_
  - Run on UNFIXED code and confirm all pass
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11, 3.12, 3.13_

- [x] 3. Fix Finding 1: invited-set lifecycle
  - [x] 3.1 Implement the fix
    - `channel-registry.ts`: export `INVITED_MAX = 100`; private `record` (delete, add, evict oldest); `invite` uses it so a re-invite moves the entry to newest; `part(clientId, name, nick?)` and `removeClient(clientId, nick?)` delete the nick key; new `renameNick(clientId, oldNick, newNick)`
    - Call sites: `part.ts` `partOne` and `kick.ts` pass the leaving nick; `quit.ts` `quitClient` passes `client.nick`; `registration.ts` `handleNick` calls `renameNick` after `setNick` succeeds for a registered client, before the `NICK` broadcast
    - _Bug_Condition: isBugCondition_1(X) from bugfix.md_
    - _Expected_Behavior: invited-set invariant (size at most 100, no member, only registered or resolver-claimed keys)_
    - _Preservation: join, last-leaver, rfc1459 sharing, resolver claims_
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4, 3.13_
  - [x] 3.2 Write property test: **Property 1: Bug Condition** - Invited-set invariant
    - `apps/ircd/test/agent-commands-fixes.invited.property.test.ts`; drives `createServer(loadConfig({}), { error })` with virtual clients and a model (nick pool of about 6 with case and rfc1459 variants, channels `#a` and `#b`, resolver for a fixed claimable subset, ops `connect`, `join`, `part`, `quit`, `nick`, `kick`, `invite` in `fc.array(op, { maxLength: 60 })`)
    - After each op assert size at most `INVITED_MAX`, no current member, every key registered or resolver-claimed, and ordered keys equal the model
    - fast-check, at least 100 runs, tag `Feature: ircd-agent-commands-fixes, Property 1: Bug Condition - Invited-set invariant`
    - _Requirements: 2.1, 2.2, 2.3, 2.4_
  - [x] 3.3 Write registry-level cap property in the same file
    - Invite from a pool of 150 distinct nicks directly on `ChannelRegistry`; size never exceeds `INVITED_MAX` and oldest-first eviction matches the model, including re-invites and `renameNick`
    - fast-check, at least 100 runs, same tag as 3.2
    - _Requirements: 2.3, 2.4_

- [x] 4. Fix Finding 2: WHOIS extra lines and guaranteed `318`
  - [x] 4.1 Implement the fix
    - `whois.ts`: export `WHOIS_EXTRA_MAX = 10` and pure `sanitizeWhoisExtra(value: unknown)` returning `{ lines, problems }` (non-array gives no lines, non-strings skipped, cap applied after filtering); `extraLines` calls `whoisExtra()` once, logs problems with command `WHOIS`, client id, target id and value type
    - `buildWhoisReplies` fills a caller-owned array and no longer appends `318`; `handleWhois` appends `318` in `finally`, logs build failures, then sends all replies
    - _Bug_Condition: X is WHOIS and whoisExtra() throws, is not an array, has non-string elements, or has more than 10 strings_
    - _Expected_Behavior: exactly one `318` last, at most 10 `320`_
    - _Preservation: valid arrays of up to 10 strings, `401` then `318`, `431`_
    - _Requirements: 2.5, 2.6, 2.7, 2.8, 3.6, 3.7_
  - [x] 4.2 Write property test: **Property 2: Bug Condition** - WHOIS always terminates with one 318
    - `apps/ircd/test/agent-commands-fixes.whois.property.test.ts`; arbitrary `whoisExtra` (thrower, `undefined`, `null`, string, object, number, mixed arrays up to 30); expected `320` lines computed by the test with its own filter and `slice(0, 10)`
    - fast-check, at least 100 runs, tag `Feature: ircd-agent-commands-fixes, Property 2: Bug Condition - WHOIS always terminates with one 318`
    - _Requirements: 2.5, 2.6, 2.7, 2.8_

- [x] 5. Fix Finding 3: AWAY normalization
  - [x] 5.1 Implement the fix
    - `text-limits.ts`: add `normalizeAway(text)` (`stripControl`, `trim`, `clampBytes` to AWAYLEN, `trimEnd`; `""` means not away)
    - `away.ts` decides `305` or `306` from the normalized value; `VirtualClientImpl.setAway` uses the same function
    - _Bug_Condition: X is AWAY and cleaned text is blank and raw text is non-empty_
    - _Expected_Behavior: away cleared and `305`; otherwise trimmed, clamped text and `306`_
    - _Preservation: real text, bare `AWAY`, `451`_
    - _Requirements: 2.9, 3.8_
  - [x]* 5.2 Write property test: **Property 3: Bug Condition** - AWAY normalization
    - `apps/ircd/test/agent-commands-fixes.away.property.test.ts`; `normalizeAway` equals the model, is at most AWAYLEN bytes, has no edge whitespace; router `AWAY` and `setAway` leave the same value, `305` iff empty
    - fast-check, at least 100 runs, tag `Feature: ircd-agent-commands-fixes, Property 3: Bug Condition - AWAY normalization`
    - _Requirements: 2.9_

- [x] 6. Fix Finding 4: INVITE event fields and `301`
  - [x] 6.1 Implement the fix
    - `event-bus.ts`: `IrcInviteEvent` gains `targetKey` and `targetOnline`
    - `invite.ts`: publish `irc_lower(targetNick)` and `target !== undefined`; send `awayReply` (`301`) after `341` only for a connected target with away text; rejected invites unchanged
    - _Bug_Condition: X is accepted INVITE_
    - _Expected_Behavior: new event fields; `341` then one `301` for an away target_
    - _Preservation: `341` and `INVITE` for non-away targets, old event fields, rejection order_
    - _Requirements: 2.10, 2.11, 3.4, 3.5, 3.9_

- [x] 7. Fix Finding 5: shared reply helpers
  - [x] 7.1 Remove local copies
    - Delete local `numeric` in `away.ts`, `message.ts`, `registration.ts` and local `prefixOf` in `message.ts`; import from `replies.ts`
    - _Bug_Condition: X is source of away.ts, message.ts, registration.ts with local copies_
    - _Expected_Behavior: no local definitions; output byte-identical_
    - _Requirements: 2.12, 3.11_

- [x] 8. Fix Finding 6: transient TCP resets at debug level
  - [x] 8.1 Implement the fix
    - `command-router.ts`: `RouterLogger.debug?` optional
    - New `socket-errors.ts`: `TRANSIENT_SOCKET_CODES`, `socketErrorCode`, `logSocketError(logger, label, clientId, error)`
    - `tcp-transport.ts` and `ws-transport.ts` call `logSocketError` and still destroy the socket; `index.ts` adds `debug`, enabled only when `IRCD_DEBUG` is `1`, with the existing redaction
    - _Bug_Condition: X is a TCP socket error with code ECONNRESET or EPIPE_
    - _Expected_Behavior: debug log with client id, socket destroyed, no error entry_
    - _Preservation: other codes log at error; socket destroyed; slot released on `close`_
    - _Requirements: 2.13, 3.12_

- [x] 9. Checkpoint: Findings 1 to 3 and exploration tests
  - Re-run the exploration tests from task 1 (do NOT write new tests); **Property 1: Expected Behavior** - all pass now
  - Re-run the preservation tests from task 2; **Property 2: Preservation** - all still pass
  - Run `pnpm --filter @seance/ircd typecheck` and `pnpm --filter @seance/ircd test`; ask the user if questions arise
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11, 2.12, 2.13, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11, 3.12, 3.13_

- [x] 10. Final checkpoint
  - `pnpm typecheck && pnpm test` pass; if the root turbo run hangs, use `pnpm --filter @seance/ircd typecheck` and `pnpm --filter @seance/ircd test`
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11, 2.12, 2.13, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11, 3.12, 3.13_

## Notes

- Tasks 1 and 2 run on unfixed code: every task 1 test must fail, every task 2 test must pass.
- Task 5.2 is optional (marked `*`); the other property tests are required.
- Property tests use fast-check with at least 100 runs and carry the tag `Feature: ircd-agent-commands-fixes, Property N: <text>`.
- Tasks run in order. Tasks that edit the same file must not run in parallel: `registration.ts` (3.1, 7.1), `away.ts` (5.1, 7.1).
- Root `pnpm typecheck` and `pnpm test` may hang under turbo; per-package runs are acceptable.
- Coding tasks only; `bugfix.md`, `design.md` and `.config.kiro` are not modified.
