# Tasks: ircd-core

- [ ] 1. Protocol package (`packages/irc-protocol`)
  - [ ] 1.1 Implement `parse(line)` per RFC 2812 grammar, tolerant of bare LF, uppercasing commands. _Requirements: 1.1, 1.4, 1.6_
  - [ ] 1.2 Implement `serialize(msg)` with trailing-parameter rules, CRLF, and 512-byte guard. _Requirements: 1.3_
  - [ ] 1.3 Implement `LineFramer` that yields complete lines and flags overlong lines. _Requirements: 1.1, 1.2, 2.2_
  - [ ] 1.4 Add `Numerics` constants, `irc_lower` (rfc1459), `isValidNick`, `isValidChannel`. _Requirements: 3.3, 3.4, 5.3_
  - [ ] 1.5 Add fast-check and write property tests P1–P5. _Requirements: 1.1, 1.3, 2.2, 3.3_

- [ ] 2. Server core (`apps/ircd`)
  - [ ] 2.1 Define `Client` interface and `ConnectionManager` (nick index, registration state). _Requirements: 3.3, 11.2_
  - [ ] 2.2 Implement `ChannelRegistry` with membership flags and `isOp` / `canSpeak`. _Requirements: 5.1, 5.6, 6.5_
  - [ ] 2.3 Implement `CommandRouter` with registration gating, `421`, and `461` checks. _Requirements: 1.5, 3.6, 3.7_
  - [ ] 2.4 Implement in-process `EventBus` (`irc.message`, `irc.mode`, `irc.kick`). _Requirements: 9.8, 10.4_

- [ ] 3. Registration and keep-alive
  - [ ] 3.1 `PASS`, `NICK`, `USER` handlers with `464`, `462`, `431`, `432`, `433`. _Requirements: 3.1–3.6_
  - [ ] 3.2 Welcome burst `001`–`004` and haunted MOTD `375`/`372`/`376`. _Requirements: 3.8_
  - [ ] 3.3 Nick change broadcast to peers. _Requirements: 3.9_
  - [ ] 3.4 `PING`/`PONG` handlers and idle/timeout timers. _Requirements: 4.1–4.3_

- [ ] 4. Channels and messaging
  - [ ] 4.1 `JOIN` (multi-channel, auto-op creator, topic + names on join). _Requirements: 5.1–5.3, 5.7_
  - [ ] 4.2 `PART` with reason and empty-channel cleanup. _Requirements: 5.4–5.6_
  - [ ] 4.3 `PRIVMSG` to channel and user, including `+m`, `401`/`403`/`404`/`411`/`412`, `301`. _Requirements: 6.1–6.6, 6.8_
  - [ ] 4.4 `NOTICE` with no error replies. _Requirements: 6.7_
  - [ ] 4.5 `TOPIC` query/set with op check. _Requirements: 7.1–7.4_
  - [ ] 4.6 `NAMES` with `@`/`+` prefixes and 512-byte splitting. _Requirements: 8.1, 8.2_
  - [ ] 4.7 `LIST`. _Requirements: 8.3_

- [ ] 5. Moderation
  - [ ] 5.1 `MODE` for `+o`/`-o`, `+v`/`-v`, `+m`/`-m`, query `324`, errors `441`/`472`/`482`. _Requirements: 9.1–9.8_
  - [ ] 5.2 `KICK` with op check and kick event. _Requirements: 10.1–10.4_
  - [ ] 5.3 `QUIT` with single broadcast per peer and nick release. _Requirements: 11.1, 11.2_

- [ ] 6. Transports
  - [ ] 6.1 `TcpTransport` on configurable port (default 6667). _Requirements: 2.1, 2.4_
  - [ ] 6.2 `WsTransport` via Fastify + `ws`, multi-line frames. _Requirements: 2.2, 2.4_
  - [ ] 6.3 Shared parse/route pipeline for both transports; `417` for overlong input. _Requirements: 1.2, 2.3_
  - [ ] 6.4 Entry point `src/index.ts` reading config from env (ports, server password, server name). _Requirements: 2.1, 3.1_

- [ ] 7. Virtual clients
  - [ ] 7.1 Implement `VirtualClient` (`dispatch`, `onMessage`) routed through `CommandRouter`. _Requirements: 12.1–12.3_

- [ ] 8. Verification
  - [ ] 8.1 Property tests P6–P9 over handler state. _Requirements: 3.3, 5.6, 6.5, 8.2, 10.1, 11.1_
  - [ ] 8.2 Integration test: two TCP clients + one WebSocket client chat in `#test`. _Requirements: 2.1–2.3, 5.2, 6.1_
  - [ ] 8.3 Manual M1 exit check: two irssi clients chat via `localhost:6667`. _Requirements: 2.1, 3.8, 6.1_
