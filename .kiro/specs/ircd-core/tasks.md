# Implementation Plan: ircd-core

## Overview

Build the `@seance/irc-protocol` pure package first (parser, serializer, framer, numerics, case-mapping), then the in-memory server core in `apps/ircd` (connection and channel state, command router, event bus), then the command handlers, transports, and the in-process virtual client. Each step builds on the previous one and ends wired into the router or entry point so no code is left orphaned. Property tests P1–P9 from the design are placed next to the code they validate.

## Tasks

- [x] 1. Protocol package (`packages/irc-protocol`)
  - [x] 1.1 Implement `IrcMessage` type and `parse(line)`
    - Parse RFC 2812 grammar (optional prefix, command, up to 15 params, trailing param)
    - Tolerate a bare LF, strip CRLF, uppercase the command
    - Return a `ParseError` sentinel for unparseable lines rather than throwing
    - _Requirements: 1.1, 1.4, 1.6_

  - [x] 1.2 Implement `serialize(msg)`
    - Prefix the last param with `:` when it contains a space, starts with `:`, or is empty
    - Terminate with CRLF; throw if the result exceeds 512 UTF-8 bytes including CRLF
    - _Requirements: 1.3_

  - [x] 1.3 Implement `LineFramer`
    - Accumulate Buffer/string chunks, yield complete lines on CRLF or bare LF
    - Flag lines that exceed 512 bytes including CRLF so the transport can emit `417`
    - _Requirements: 1.1, 1.2, 2.2_

  - [x] 1.4 Add `Numerics`, `irc_lower`, `isValidNick`, `isValidChannel`
    - Named numeric constants for every reply used by the server
    - `irc_lower` rfc1459 case-mapping; nick and channel validators
    - Export the package surface from `src/index.ts`
    - _Requirements: 3.3, 3.4, 5.3_

  - [x] 1.5 Write property test P1 (round-trip)
    - **Property P1: Round-trip** — `parse(serialize(m))` deep-equals `m` for every valid `IrcMessage`
    - Add `fast-check` as a dev dependency (pinned exact version)
    - **Validates: Requirement 1.1**

  - [x] 1.6 Write property test P2 (length bound)
    - **Property P2: Length bound** — `serialize(m)` is ≤ 512 UTF-8 bytes including CRLF, or throws
    - **Validates: Requirement 1.3**

  - [x] 1.7 Write property test P3 (CRLF)
    - **Property P3: CRLF** — every serialized line ends in exactly one `\r\n` and contains no other CR/LF
    - **Validates: Requirement 1.3**

  - [x] 1.8 Write property test P4 (framing independence)
    - **Property P4: Framing independence** — splitting a byte stream into arbitrary chunks yields the same lines from `LineFramer`
    - **Validates: Requirements 1.1, 2.2**

  - [x] 1.9 Write property test P5 (case-mapping)
    - **Property P5: Case-mapping** — `irc_lower` is idempotent and `irc_lower(a) == irc_lower(b)` implies a nick collision
    - **Validates: Requirement 3.3**

- [x] 2. Checkpoint - protocol package
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Server core state and routing (`apps/ircd`)
  - [x] 3.1 Define `Client` interface and `ConnectionManager`
    - `Client` abstraction (`id`, `nick`, `user`, `registered`, `away`, `send`, `close`)
    - Track clients by id and by case-mapped nick; registration state machine
    - `broadcastToPeers(client, msg)` sending once per peer sharing a channel
    - _Requirements: 3.3, 11.2_

  - [x] 3.2 Implement `ChannelRegistry`
    - `Channel { name, topic?, modes: { moderated }, members: Map<clientId, { op, voice }> }`
    - Create on first join (creator gets `+o`), delete when empty
    - Permission helpers `isOp` and `canSpeak` (respects `+m`)
    - _Requirements: 5.1, 5.6, 6.5_

  - [x] 3.3 Implement `CommandRouter`
    - Map uppercase command to handler; registration gating
    - `421 ERR_UNKNOWNCOMMAND` and `461 ERR_NEEDMOREPARAMS` via declared minimum params
    - Catch per-message handler exceptions so one bad message cannot crash the server
    - _Requirements: 1.5, 3.6, 3.7_

  - [x] 3.4 Implement in-process `EventBus`
    - Typed emitter publishing `irc.message`, `irc.mode`, `irc.kick`
    - _Requirements: 9.8, 10.4_

  - [x] 3.5 Write unit tests for router and registry
    - Registration gating, unknown command, needmoreparams, channel create/delete, permission helpers
    - _Requirements: 1.5, 3.6, 3.7, 5.1, 5.6, 6.5_

- [x] 4. Registration and keep-alive
  - [x] 4.1 `PASS`, `NICK`, `USER` handlers
    - Errors `464`, `462`, `431`, `432`, `433`; case-insensitive nick-in-use check
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [x] 4.2 Welcome burst and MOTD
    - Send `001`–`004` then `375`/`372`/`376` on completed registration
    - _Requirements: 3.8_

  - [x] 4.3 Nick change broadcast
    - Broadcast a `NICK` change to the client and every peer sharing a channel
    - _Requirements: 3.9_

  - [x] 4.4 `PING`/`PONG` handlers and idle/timeout timers
    - Reply `PONG <server> :<token>`; idle `PING`; close with `Ping timeout` on no answer
    - _Requirements: 4.1, 4.2, 4.3_

  - [x] 4.5 Write property test P6 (unique nicks)
    - **Property P6: Unique nicks** — after any sequence of NICK/QUIT operations, no two registered clients share a case-mapped nick
    - **Validates: Requirements 3.3, 11.2**

  - [x] 4.6 Write unit tests for registration and keep-alive
    - Error replies, welcome/MOTD ordering, ping timeout behaviour
    - _Requirements: 3.1, 3.2, 3.5, 3.8, 4.1, 4.3_

- [x] 5. Channels and messaging
  - [x] 5.1 `JOIN` handler
    - Multi-channel comma list, auto-op the creator, send topic (`332`/`331`) and names (`353`/`366`), `403` on invalid name
    - _Requirements: 5.1, 5.2, 5.3, 5.7_

  - [x] 5.2 `PART` handler
    - Broadcast `PART` with optional reason to all members including the leaver; `442` when not a member; remove empty channels
    - _Requirements: 5.4, 5.5, 5.6_

  - [x] 5.3 `PRIVMSG` handler
    - Channel and user delivery; `+m` enforcement; errors `401`/`403`/`404`/`411`/`412`; `301` when private target is away
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.8_

  - [x] 5.4 `NOTICE` handler
    - Same delivery path as `PRIVMSG` but never emit any error reply
    - _Requirements: 6.7_

  - [x] 5.5 `TOPIC` handler
    - Query (`332`/`331`); op-only set with broadcast; `482` for non-op; `442` for non-member
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [x] 5.6 `NAMES` handler
    - `353` with `@`/`+` prefixes then `366`; split across multiple `353` lines to respect 512 bytes
    - _Requirements: 8.1, 8.2_

  - [x] 5.7 `LIST` handler
    - One `322` per channel (name, visible count, topic) then `323`
    - _Requirements: 8.3_

  - [x] 5.8 Write property test P7 (membership consistency)
    - **Property P7: Membership consistency** — after any JOIN/PART/KICK/QUIT sequence, every channel is non-empty and every member is a live client
    - **Validates: Requirements 5.6, 10.1, 11.1**

  - [x] 5.9 Write property test P8 (moderation)
    - **Property P8: Moderation** — in a `+m` channel a message from a member without `+o`/`+v` is never delivered
    - **Validates: Requirement 6.5**

  - [x] 5.10 Write property test P9 (NAMES split)
    - **Property P9: NAMES split** — every `353` line respects the length bound and the union of names equals the member set
    - **Validates: Requirement 8.2**

  - [x] 5.11 Write unit tests for channel and messaging handlers
    - JOIN/PART edge cases, PRIVMSG error replies, TOPIC permissions, NOTICE silence, LIST output
    - _Requirements: 5.4, 6.3, 6.6, 6.7, 7.3, 8.3_

- [x] 6. Checkpoint - core handlers
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Moderation
  - [x] 7.1 `MODE` handler
    - `+o`/`-o`, `+v`/`-v`, `+m`/`-m` with broadcast; query `324`; errors `441`/`472`/`482`; publish `irc.mode` event
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8_

  - [x] 7.2 `KICK` handler
    - Broadcast `KICK` and remove target; `482` for non-op; `441` when target not in channel; publish `irc.kick` event
    - _Requirements: 10.1, 10.2, 10.3, 10.4_

  - [x] 7.3 `QUIT` handler
    - Single `QUIT` broadcast per peer, remove from all channels, close connection, release nick
    - _Requirements: 11.1, 11.2_

  - [x] 7.4 Write unit tests for moderation handlers
    - Mode changes and errors, kick permissions and events, quit broadcast de-duplication and nick release
    - _Requirements: 9.1, 9.5, 9.6, 9.7, 10.2, 10.3, 11.1, 11.2_

- [x] 8. Transports
  - [x] 8.1 `TcpTransport`
    - `node:net` server on a configurable port (default 6667); one `LineFramer` per socket
    - Socket close maps to a synthetic `QUIT`
    - _Requirements: 2.1, 2.4_

  - [x] 8.2 `WsTransport`
    - Fastify + `ws`; feed each text frame to a `LineFramer` so multiple lines per frame work
    - Socket close maps to a synthetic `QUIT`
    - _Requirements: 2.2, 2.4_

  - [x] 8.3 Shared parse/route pipeline and `417`
    - Both transports build a `NetworkClient` and feed parsed messages to the same router
    - Emit `417 ERR_INPUTTOOLONG` for overlong input flagged by the framer
    - _Requirements: 1.2, 2.3_

  - [x] 8.4 Entry point `src/index.ts`
    - Read config from env (ports, server password, server name); start both transports; wire the `EventBus`
    - _Requirements: 2.1, 3.1_

  - [x] 8.5 Write integration test for transports
    - Two TCP clients and one WebSocket client register, join `#test`, and exchange `PRIVMSG`
    - _Requirements: 2.1, 2.2, 2.3, 5.2, 6.1_

- [x] 9. Virtual clients
  - [x] 9.1 Implement `VirtualClient`
    - `dispatch(msg)` routed through `CommandRouter`; `onMessage(listener)` subscription
    - Indistinguishable from network clients to other users
    - _Requirements: 12.1, 12.2, 12.3_

  - [x] 9.2 Write unit test for virtual client parity
    - A virtual client joining and messaging appears identical to peers as a network client
    - _Requirements: 12.2, 12.3_

- [x] 10. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional (unit, property, and integration tests) and can be skipped for a faster MVP.
- Each task references specific requirement sub-clauses for traceability.
- Checkpoints provide incremental validation at package, core-handler, and final boundaries.
- Property tests P1–P9 live next to the code they validate so errors surface early.
- The manual M1 exit check (two irssi clients on `localhost:6667`) is a human verification step, not a coding task, so it is intentionally excluded from this plan.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.3", "1.4"] },
    { "id": 1, "tasks": ["1.2", "1.5", "1.8", "1.9"] },
    { "id": 2, "tasks": ["1.6", "1.7", "3.1", "3.2", "3.4"] },
    { "id": 3, "tasks": ["3.3", "4.1", "4.2", "4.3", "4.4"] },
    { "id": 4, "tasks": ["3.5", "4.5", "4.6", "5.1", "5.2", "5.3", "5.4", "5.5", "5.6", "5.7"] },
    { "id": 5, "tasks": ["5.8", "5.9", "5.10", "5.11", "7.1", "7.2", "7.3"] },
    { "id": 6, "tasks": ["7.4", "8.1", "8.2", "9.1"] },
    { "id": 7, "tasks": ["8.3", "9.2"] },
    { "id": 8, "tasks": ["8.4"] },
    { "id": 9, "tasks": ["8.5"] }
  ]
}
```
