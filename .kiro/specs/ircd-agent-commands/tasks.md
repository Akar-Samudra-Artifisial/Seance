# Implementation Plan: ircd-agent-commands

## Overview

Extend `apps/ircd` with `AWAY`, `WHOIS` and `INVITE`, building on `ircd-core`. Work starts with the numerics and shared helpers (clock, text limits, reply builders, `packEntries`), then the two standalone fixes (host normalization, `NetworkClient.close`), then the reflected-input clamp and activity tracking that the new handlers depend on. The three handlers follow, each with unit tests and its property test. A final pass wires the router, adds the Req 11.2 source check, the line-bound property P1 and the README section. Properties P1–P6 from the design sit next to the code they validate. Nothing in `apps/runner` changes.

## Tasks

- [x] 1. Protocol numerics (`packages/irc-protocol`)
  - [x] 1.1 Add `RPL_WHOISIDLE` and `RPL_WHOISSPECIAL` to `Numerics`
    - `RPL_WHOISIDLE: "317"` and `RPL_WHOISSPECIAL: "320"`
    - Comment that `320` is not in RFC 2812 (de facto numeric from ircu, UnrealIRCd, Ergo)
    - _Requirements: 11.1_

  - [x] 1.2 Update the numerics test
    - Assert both new constants and their values; keep existing assertions
    - _Requirements: 11.1_

- [x] 2. Shared foundations (`apps/ircd`)
  - [x] 2.1 Add `clock.ts` and `RouterContext.now`
    - `nowMs(ctx)` and `nowSeconds(ctx)` defaulting to `Date.now`
    - Add optional `now?: () => number` to `RouterContext` in `command-router.ts`
    - _Requirements: 4.5_

  - [x] 2.2 Add `AWAYLEN` and `stripControl` to `text-limits.ts`
    - `AWAYLEN = 200`
    - `stripControl(text)` replaces CR, LF and NUL with a space
    - _Requirements: 1.1, 1.7, 1.8, 3.3_

  - [x] 2.3 Extract `packEntries` into `entry-lines.ts` and switch `names.ts` to it
    - Same packing algorithm as the current `buildNamesReplies` loop; never split an entry; no entries gives no lines
    - Cut an entry that cannot fit alone with `clampBytes` instead of throwing
    - `353` output stays byte-identical
    - _Requirements: 2.5_

  - [x] 2.4 Add `replies.ts` shared reply helpers
    - `numeric`, `prefixOf`, `reflectedReply` (built on `clampTrailing`, no second truncation; makes the value a legal middle parameter) and `awayReply`
    - Use `Numerics` constants only
    - _Requirements: 1.4, 9.1, 9.3, 9.5, 11.2_

  - [x] 2.5 Write unit tests for the foundations
    - `nowSeconds` with an injected clock, `stripControl`, `packEntries` split/no-split/empty/oversized entry
    - `reflectedReply` identity when it fits, code point boundary clamp, space/leading `:`/empty value handling
    - Existing `names` and ircd-core P9 tests still pass unchanged
    - _Requirements: 2.5, 4.5, 9.1, 9.3, 9.5_

- [x] 3. Host normalization
  - [x] 3.1 Implement `normalizeHost` in `host.ts`
    - `undefined` stays `undefined`, `""` stays `""`
    - `::ffff:` (any case) plus a dotted-quad becomes the dotted-quad; `::ffff:` plus anything else, or any address starting with `:`, gets `0` prepended; everything else unchanged
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.10, 8.11_

  - [x] 3.2 Wire `normalizeHost` into `TcpTransport` and `WsTransport`
    - Both call the one implementation on `remoteAddress` before it becomes `client.host`
    - _Requirements: 8.5, 8.6, 8.7_

  - [x] 3.3 Write unit table test for `normalizeHost`
    - IPv4, `::ffff:127.0.0.1`, uppercase `::FFFF:`, `::1`, `2001:db8::1`, `fe80::1`, `::ffff:abcd:1234`, empty string, `undefined`
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.10, 8.11_

  - [x] 3.4 Write transport tests for the peer host
    - Extend `transports.test.ts` for TCP and WebSocket: IPv4, IPv4-mapped (server bound to `::`), `::1` (skip when IPv6 loopback is unavailable); read the host from `WHOIS` `311` or the `JOIN` prefix; port `0`, close in `afterEach`
    - `vi.mock` of `host.js` wrapping the real function asserts both transports call it with the raw `remoteAddress` and store its result (covers full IPv6)
    - _Requirements: 8.1, 8.2, 8.5, 8.6, 8.7_

  - [x] 3.5 Write property test P4 (host normalization shape)
    - **Property 4: Host normalization shape** — idempotent, output never starts with `:`, no `::ffff:` left for dotted-quad mapped input
    - Use fast-check with `numRuns` ≥ 100 in `host.property.test.ts`; tag `// Feature: ircd-agent-commands, Property 4: normalizeHost is idempotent and never yields a leading ':'`
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.8, 8.9**

- [x] 4. `NetworkClient.close` destroy timer
  - [x] 4.1 Add `Wire.isDestroyed()` and fix `close`
    - Required method on `Wire`; TCP uses `socket.destroyed`, WS uses `readyState === CLOSED`
    - Already closed: return; wire destroyed: mark closed only (no `end()`, no timer); otherwise send `ERROR`, mark closed, call `end()` once, arm one destroy timer
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

  - [x] 4.2 Update fake `Wire` objects in existing tests
    - Add `isDestroyed` to every fake wire so typecheck and tests pass
    - _Requirements: 10.1_

  - [x] 4.3 Write unit tests for `close` (`network-client-close.test.ts`)
    - Fake `Wire` and fake timers: destroyed wire (no `end`, no timer), normal close (one `end`, one timer), repeated close, wire destroyed during grace cancels the timer, grace elapsed calls `destroy()` once and leaves no pending timer
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

- [x] 5. Checkpoint - foundations, host normalization, close
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Reflected-input clamp
  - [x] 6.1 Switch existing `401`/`403`/`441`/`442`/`443`/`482` call sites to `reflectedReply`
    - Cover `join.ts`, `part.ts`, `topic.ts`, `mode.ts`, `kick.ts`, `message.ts` (`PRIVMSG`/`NOTICE`) and any other handler sending these numerics
    - Replies that reflect nothing keep their local `numeric()` helpers
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

  - [x] 6.2 Write unit tests for the reflected clamp (`reflected-clamp.test.ts`)
    - One oversized-input case per handler and numeric (`JOIN`, `PART`, `TOPIC`, `MODE`, `KICK`, `PRIVMSG`, `NOTICE`)
    - Each reply is ≤ 512 bytes, the connection stays open, the logger spy sees no error, and a short input yields the byte-identical unclamped reply
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

  - [x] 6.3 Write property test P5 (reflected clamp identity and bound)
    - **Property 5: Reflected clamp identity and bound** — identity when the reply fits, otherwise a code point prefix with no new U+FFFD and a reply ≤ 512 bytes, over `401`, `403`, `441`, `442`, `443`, `482`
    - Use fast-check with `numRuns` ≥ 100; mix 1- to 4-byte characters; tag `// Feature: ircd-agent-commands, Property 5: reflected clamp is identity when the reply fits, else a valid prefix within 512 bytes`
    - **Validates: Requirements 9.1, 9.3**

- [x] 7. Client fields and activity tracking
  - [x] 7.1 Add `Client` fields and stamp sign-on
    - `realname?`, `signonAt?`, `lastActivityAt?` on `Client`
    - `handleUser` stores `client.realname` after `setUser` succeeds
    - `onRegistrationComplete` sets `signonAt = lastActivityAt = nowSeconds(ctx)` for network and virtual clients
    - _Requirements: 2.3, 4.1, 4.4_

  - [x] 7.2 Stamp `lastActivityAt` in `deliverMessage`
    - Only on the `"delivered"` result of `PRIVMSG` and `NOTICE`; rejected sends and other commands never stamp
    - _Requirements: 4.2, 4.3, 4.4, 4.6_

  - [x] 7.3 Write unit tests for activity tracking (`activity.test.ts`)
    - Sign-on and activity stamps for network and virtual clients with a fake clock
    - Stamped by `PRIVMSG`/`NOTICE`; not stamped by `PING`, `PONG`, `JOIN`, `MODE` or by rejected sends (no recipient, no text, no such target)
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_

- [x] 8. Checkpoint - reflected clamp and activity
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. AWAY command
  - [x] 9.1 Implement `handlers/away.ts`, `AWAYLEN=200` in `005`, and register `AWAY`
    - Non-empty text: store `clampBytes(text, AWAYLEN)`, reply `306`; empty or missing: delete away text, reply `305`
    - Add `AWAYLEN=200` to the `005` tokens in `onRegistrationComplete`
    - Register `AWAY` with `minParams: 0` in `createRouter` so it can be tested through the server
    - _Requirements: 1.1, 1.2, 1.3, 1.8, 1.9_

  - [x] 9.2 Use `awayReply` in `message.ts` and add `VirtualClient.setAway`
    - Replace the unclamped `301` in `message.ts` with `awayReply`; keep it off `NOTICE` and channel messages
    - `setAway(text?)` strips control characters, clamps to `AWAYLEN` and clears on `undefined` or `""`; no wire reply
    - _Requirements: 1.4, 1.5, 1.6, 1.7, 1.8_

  - [x] 9.3 Update existing `005` tests
    - Expect the `AWAYLEN=200` token and keep the token count within 15 parameters
    - _Requirements: 1.3_

  - [x] 9.4 Write unit tests for `AWAY` (`away.test.ts`)
    - `306` and `305`, clamp at 200 bytes on a multi-byte boundary, `005` contains `AWAYLEN=200`
    - `301` for `PRIVMSG` to a nick; none for `NOTICE` and channel `PRIVMSG`; `setAway` clamp and clear; unregistered gets `451` with no state change
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9_

  - [x] 9.5 Write property test P3 (away state model)
    - **Property 3: Away state model** — after any non-empty sequence of `AWAY` commands, a `PRIVMSG` to the client yields `301` iff the last `AWAY` had non-empty text
    - Use fast-check with `numRuns` ≥ 100 in `agent-commands.property.test.ts`; tag `// Feature: ircd-agent-commands, Property 3: 301 appears iff the last AWAY carried non-empty text`
    - **Validates: Requirements 1.1, 1.2, 1.4, 1.10**

- [x] 10. WHOIS command
  - [x] 10.1 Add the `whoisExtra` hook to `Client` and `VirtualClientOptions`
    - Optional `whoisExtra?(): readonly string[]` on `Client`; `NetworkClient` leaves it unimplemented
    - `VirtualClientOptions.whoisExtra` is assigned only when given (`exactOptionalPropertyTypes`)
    - _Requirements: 3.1, 3.5, 3.6_

  - [x] 10.2 Implement `handlers/whois.ts` and register `WHOIS`
    - Pick the nick (`params[1]` when two or more params, first entry of a comma list); missing nick gives `431` with no `318`; unknown nick gives `401` then `318`
    - Reply order: `311`, `319` (via `packEntries`, `@`/`+`/none prefixes), `312`, `320` per `whoisExtra()` line (called once, `stripControl` and `clampTrailing`), `301` via `awayReply`, `317` (idle ≥ 0, sign-on), `318`
    - A throwing `whoisExtra` is logged with `WHOIS`, client ids and the error; `320` lines are skipped and the rest still goes out
    - Register `WHOIS` with `minParams: 0` in `createRouter`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11, 2.14, 3.2, 3.3, 3.4, 3.7, 4.7_

  - [x] 10.3 Write unit tests for `WHOIS` (`whois.test.ts`)
    - Full reply order, `WHOIS server nick`, comma list, `401`+`318`, `431`, `451`
    - `319` split with many channels and prefixes; `320` order, empty or missing `whoisExtra`, called once, throwing `whoisExtra` logged with `318` still sent
    - `317` with a fake clock, including a backwards clock; `301` placement; virtual and network targets
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11, 2.14, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 4.7_

  - [x] 10.4 Write property test P2 (WHOIS terminator and membership listing)
    - **Property 2: WHOIS terminator and membership listing** — exactly one `318`; `319` entries equal the target's memberships with correct prefixes and no split entries; also for an unknown nick (`401`, `318`, no `319`)
    - Use fast-check with `numRuns` ≥ 100; multi-byte channel names, enough channels to force a split; tag `// Feature: ircd-agent-commands, Property 2: WHOIS ends with one 318 and 319 lists exactly the memberships`
    - **Validates: Requirements 2.4, 2.5, 2.11, 2.12**

- [x] 11. INVITE command
  - [x] 11.1 Add the `invited` set to `ChannelRegistry`
    - `Channel.invited: Set<string>` keyed by `irc_lower(nick)`; `invite(name, nick)`, `isInvited(name, nick)`; `join(clientId, name, nick?)` removes the nick; `JOIN` passes `client.nick`
    - A new channel starts empty; the set is discarded with the channel; `join` never consults it
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8_

  - [x] 11.2 Write unit tests for invite records (`channel-invite.test.ts`)
    - Cleared on `JOIN`, discarded with the channel, empty on recreation, unchanged by a non-invited join, one entry for case and rfc1459 variants, invites do not gate joins
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8_

  - [x] 11.3 Write property test P6 (invited set uniqueness)
    - **Property 6: Invited set uniqueness** — set size equals distinct `irc_lower` nicks invited and not yet joined; a recreated channel starts empty
    - Use fast-check with `numRuns` ≥ 100; nick pool with case variants and `[`/`{`, `]`/`}`, `\`/`|`, `~`/`^`; tag `// Feature: ircd-agent-commands, Property 6: invited set has one entry per rfc1459-equivalent nick`
    - **Validates: Requirements 7.1, 7.2, 7.4, 7.6, 7.8**

  - [x] 11.4 Add `irc.invite` event, `InviteResolver` type and `ServerOptions`
    - `IrcInviteEvent { channel, inviter, target, ts }` and the `"irc.invite"` entry in the `EventBus` `EventMap`
    - `InviteResolver = (target, channel, inviter) => boolean`; `RouterContext.inviteResolver?`
    - `createServer(config, logger, options: ServerOptions = {})` with `now` and `inviteResolver`; `now` feeds both `ctx.now` and `SessionLimits.now`
    - _Requirements: 4.5, 5.3, 6.1, 6.7_

  - [x] 11.5 Implement `handlers/invite.ts` and register `INVITE`
    - `minParams: 2`; checks in Req 5.12 order, stopping at the first failure with exactly one error: channel (`403`), inviter membership (`442`), inviter op (`482`), target resolution (`401`), target membership (`443`)
    - Registered target: record the invite, send `INVITE` to the target, `341` to the inviter, publish `irc.invite` with `ts` from the clock
    - Unregistered target: ask the resolver only for a valid nick after the op checks; claim gives `341`, event and record but no `INVITE` message; throw, thenable (with `.catch` attached) or non-`true` gives `401` and a log entry
    - Compare nick and channel with rfc1459 case-mapping; wrap the handler in `try/catch` like `KICK`; register `INVITE` in `createRouter`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 5.11, 5.12, 5.13, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 7.1_

  - [x] 11.6 Write unit tests for `INVITE` (`invite.test.ts`)
    - Success path (`341`, `INVITE` to the target, one event with `ts`), each rejection with exactly one reply and no side effects, check order with several simultaneous failures, case-mapping
    - Resolver: claim, no claim, throw, thenable, not asked for registered targets, not asked for invalid nicks, receives three plain strings; no resolver configured
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 5.11, 5.12, 5.13, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8_

- [x] 12. Router wiring and numeric source check
  - [x] 12.1 Confirm `AWAY`, `WHOIS` and `INVITE` registration in `createRouter` with an end-to-end test
    - One test drives all three commands through `createServer` over the real router, including `451` before registration
    - Fix any missing or duplicate registration
    - _Requirements: 1.9, 2.10, 5.10_

  - [x] 12.2 Write a source check for string-literal numerics
    - Test reads `handlers/away.ts`, `whois.ts` and `invite.ts` and fails on any quoted three-digit numeric literal
    - _Requirements: 11.2_

- [x] 13. Checkpoint - AWAY, WHOIS, INVITE
  - Ensure all tests pass, ask the user if questions arise.

- [x] 14. Line-bound property
  - [x] 14.1 Write property test P1 (reply line bound)
    - **Property 1: Reply line bound** — every message sent by `WHOIS`, `AWAY` and `INVITE` to the requester, inviter or target passes `serialize()` and is ≤ 512 bytes including CRLF
    - Virtual clients call `serialize()` on every received message; arbitraries mix ASCII with 2-, 3- and 4-byte characters, control characters in `whoisExtra` and away text; injected `now` and `inviteResolver`
    - Use fast-check with `numRuns` ≥ 100 in `agent-commands.property.test.ts`; tag `// Feature: ircd-agent-commands, Property 1: every WHOIS/AWAY/INVITE reply serializes to <= 512 bytes`
    - **Validates: Requirements 1.1, 1.7, 1.8, 2.5, 2.13, 3.3, 5.14**

- [x] 15. Documentation
  - [x] 15.1 Add a "Supported commands and numerics" section to the README
    - List all supported commands including `AWAY`, `WHOIS`, `INVITE`; state `AWAYLEN=200`; list numerics including `317` and `320`, noting `320` is not in RFC 2812
    - _Requirements: 11.3, 11.4_

- [x] 16. Final checkpoint - Ensure all tests pass
  - Run `pnpm typecheck && pnpm test`; ask the user if questions arise.

## Notes

- Every test sub-task is a required step in this plan, as in `ircd-core`; each handler has its own unit test sub-task and each design property P1–P6 has its own property test sub-task.
- Each task references specific requirement sub-clauses for traceability.
- Checkpoints sit after foundations/host/close, after reflected clamp/activity, after the three handlers, and at the end.
- Handler tasks 9.1, 10.2 and 11.5 register their command in `createRouter` so their tests can run through the server; task 12.1 verifies the final wiring.
- Tasks that edit the same file are in different waves of the dependency graph (for example `message.ts`, `server.ts`, `client.ts`, `virtual-client.ts`, `command-router.ts` and both transports).
- Property tests use fast-check with at least 100 runs and carry the tag `Feature: ircd-agent-commands, Property N: <text>`.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "2.2", "2.3", "3.1"] },
    { "id": 1, "tasks": ["1.2", "2.4", "3.2", "3.3", "3.5"] },
    { "id": 2, "tasks": ["2.5", "3.4", "4.1", "6.1", "7.1", "11.4"] },
    { "id": 3, "tasks": ["4.2", "4.3", "6.2", "6.3", "7.2", "10.1", "11.1"] },
    { "id": 4, "tasks": ["7.3", "9.1", "9.2", "11.2", "11.3"] },
    { "id": 5, "tasks": ["9.3", "9.4", "9.5", "10.2"] },
    { "id": 6, "tasks": ["10.3", "10.4", "11.5"] },
    { "id": 7, "tasks": ["11.6", "12.1", "12.2"] },
    { "id": 8, "tasks": ["14.1", "15.1"] }
  ]
}
```
