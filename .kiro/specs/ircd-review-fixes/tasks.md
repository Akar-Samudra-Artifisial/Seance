# Implementation Plan: ircd-review-fixes

## Overview

Each task writes the regression test first, confirms it fails, then fixes the code. Tasks are ordered so shared helpers exist before their users.

## Tasks

- [x] 1. Virtual client keep-alive and close (Req 1)
  - [x] 1.1 Add `virtual?: boolean` to `Client`; skip keep-alive in `ConnectionManager.add`/`touch` for virtual clients
  - [x] 1.2 `VirtualClient.close()` calls `quitClient`
  - [x] 1.3 Regression tests with fake timers: no `PING`, no timeout; `close()` broadcasts `QUIT`, leaves channels, frees the nick
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

- [x] 2. Clamp relayed text (Req 2)
  - [x] 2.1 Add `src/text-limits.ts` (`clampBytes`, `clampTrailing`, `TOPICLEN`, `KICKLEN`); move `clampBytes` out of `registration.ts`
  - [x] 2.2 Apply to PRIVMSG/NOTICE, PART, KICK, TOPIC, QUIT, `322`, `332`; store topics at most `TOPICLEN`; advertise in `005`
  - [x] 2.3 Regression tests at the 510/511/512-byte boundary with multi-byte text
  - _Requirements: 2.1-2.6_

- [x] 3. Constant-time `PASS` (Req 3)
  - [x] 3.1 `safeEqual` with `timingSafeEqual` on SHA-256 digests; tests for equal, different, different-length
  - _Requirements: 3.1, 3.2_

- [x] 4. `USER` validation (Req 4)
  - [x] 4.1 `validateUser`; close on invalid; `462` first when registered
  - [x] 4.2 Table-driven tests
  - _Requirements: 4.1-4.4_

- [x] 5. Final close semantics (Req 5)
  - [x] 5.1 `Wire.destroy`/`bufferedBytes`; `NetworkClient.close` arms a destroy timer; `ConnectionSession.receive` ignores input when closed
  - [x] 5.2 Wire both transports; tests with fake timers
  - _Requirements: 5.1, 5.2, 5.3_

- [x] 6. Resource limits (Req 6)
  - [x] 6.1 `TokenBucket` and `ConnectionGate` with unit tests
  - [x] 6.2 Flood control, registration timeout and write cap in `ConnectionSession`/`NetworkClient`
  - [x] 6.3 `maxConnections` in both transports
  - [x] 6.4 Config parsing for all new env vars, with validation tests
  - _Requirements: 6.1-6.5_

- [x] 7. WebSocket Origin allow-list (Req 7)
  - [x] 7.1 `src/origin.ts` with parser and matcher; unit tests
  - [x] 7.2 `verifyClient` in `WsTransport`; integration test for 403, accept, and no-Origin
  - _Requirements: 7.1-7.5_

- [x] 8. Checkpoint: fixes and docs
  - `pnpm typecheck` and `pnpm test` pass; new env vars documented in `README.md`
  - _Requirements: 6.5, 7.4_

- [ ] 9. Property tests for the design's Correctness Properties
  - Add `fast-check` tests in `apps/ircd/test/review-fixes.property.test.ts`; name each `RF-P<n> <title>` to avoid clashing with the `ircd-core` P-numbers
  - [x] 9.1 RF-P2/RF-P3: for any prefix, command and Unicode text, the serialized relayed line is at most 512 bytes including CRLF, the clamped text is a whole-code-point prefix of the input, and text that already fits is unchanged (`clamp(clamp(t)) == clamp(t)`)
    - _Requirements: 2.1, 2.5, 2.6_
  - [x] 9.2 RF-P4: for any strings `a` and `b`, `safeEqual(a, b)` is true if and only if `a === b`
    - _Requirements: 3.2_
  - [x] 9.3 RF-P5: for any `USER` input, registration succeeds if and only if the username and real name satisfy the documented rules
    - _Requirements: 4.1, 4.2, 4.4_
  - [x] 9.4 RF-P7: for any sequence of arrivals, the token bucket never exceeds `floodBurst` at once, `ConnectionGate` never exceeds `maxConnections`, and queued bytes never exceed `maxWriteBufferBytes`
    - _Requirements: 6.1, 6.2, 6.4_
  - [x] 9.5 RF-P8: `isOriginAllowed` accepts an `Origin` if and only if it is absent, listed (case-insensitive), or the list holds `*`
    - _Requirements: 7.1, 7.2, 7.3_
  - [x] 9.6 RF-P1: for any number of `close()` calls on a virtual client, no keep-alive timer is scheduled and each peer sees exactly one `QUIT`
    - _Requirements: 1.1, 1.3, 1.4_
  - [x] 9.7 RF-P6: after `close()`, a network client routes no further input and the wire is destroyed no later than the grace period unless it closed earlier
    - _Requirements: 5.1, 5.2, 5.3_

- [x] 10. Final checkpoint
  - `pnpm typecheck` and `pnpm test` pass, including the new property tests; per-package runs are acceptable if the root run times out

## Notes

- Tasks 1 to 8 are complete; tasks 9 and 10 cover the Correctness Properties added to `design.md`.
- Property tests are named `RF-P<n>` so they do not clash with the `ircd-core` P1 to P9 tests.
- Root `pnpm typecheck` and `pnpm test` may time out under turbo; per-package runs are acceptable.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["9.1", "9.2", "9.3", "9.4", "9.5", "9.6", "9.7"] },
    { "id": 1, "tasks": ["10"] }
  ]
}
```
