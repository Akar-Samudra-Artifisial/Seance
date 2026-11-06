# Requirements Document

## Introduction

`ircd-review-fixes` is a bugfix spec for seven findings from the review of `ircd-core` (`apps/ircd`). It covers keep-alive and lifecycle of virtual clients, silently dropped relayed lines, password comparison, `USER` validation, connection close semantics, resource limits required by `.kiro/steering/security.md`, and a configurable WebSocket Origin allow-list. Every fix starts with a regression test that fails on the current code.

## Glossary

- **IRCd:** the server in `apps/ircd`.
- **Network client:** a TCP or WebSocket connection (`NetworkClient`).
- **Virtual client:** an in-process client created with `createVirtualClient`.
- **Relayed line:** a message the IRCd builds with a `nick!user@host` prefix and sends to other clients (`PRIVMSG`, `NOTICE`, `PART`, `KICK`, `TOPIC`, `QUIT`), or a numeric that echoes user text (`322`, `332`).
- **Line limit:** 512 bytes including CRLF, measured in UTF-8 bytes.
- **Grace period:** the delay between asking a transport to close politely and destroying the socket.

---

## Requirements

### Requirement 1: Virtual clients are not subject to keep-alive and close cleanly

**Finding:** `virtual-client.ts:79-85`, `connection-manager.ts:150`.

**User Story:** As an agent runner, I want in-process clients to stay connected without answering `PING`, and I want `close()` to fully disconnect them, so that agents are not dropped by a timeout and leave no stale state.

#### Acceptance Criteria

1. WHEN a virtual client is added to the `ConnectionManager`, THE IRCd SHALL NOT schedule an idle timer, `PING` or ping timeout for it.
2. WHEN a virtual client sends any command, THE IRCd SHALL NOT start keep-alive timers for it.
3. WHEN `close(reason)` is called on a virtual client, THE IRCd SHALL run the same quit sequence as a network client: broadcast `QUIT` once per peer, remove the client from every channel, and release its nick.
4. WHEN `close(reason)` is called on a virtual client that has already quit, THE IRCd SHALL do nothing further.
5. WHEN a network client is added, THE IRCd SHALL keep the existing keep-alive behaviour.

### Requirement 2: Relayed lines never exceed the line limit

**Finding:** relayed `PRIVMSG`/`NOTICE`/`PART`/`KICK`/`TOPIC`/`QUIT`, `322`, `332` can exceed 512 bytes once the sender prefix is added and are then dropped by `serialize`.

**User Story:** As a user, I want a long message to arrive shortened rather than vanish, so that nobody loses a message silently.

#### Acceptance Criteria

1. WHEN the IRCd relays a `PRIVMSG`, `NOTICE`, `PART`, `KICK`, `TOPIC` or `QUIT` whose free-text parameter would push the line past the line limit, THE IRCd SHALL cut the text at a UTF-8 code point boundary so the line fits, and deliver it.
2. WHEN the IRCd sends `322` or `332`, THE IRCd SHALL apply the same cut to the topic text.
3. WHEN a topic is set, THE IRCd SHALL store at most `TOPICLEN` bytes; WHEN a `KICK` reason is given, THE IRCd SHALL use at most `KICKLEN` bytes.
4. THE IRCd SHALL advertise `TOPICLEN=<n>` and `KICKLEN=<n>` in `005 RPL_ISUPPORT`.
5. WHEN text is cut, THE IRCd SHALL NOT split a multi-byte character and SHALL NOT log an error.
6. WHEN text already fits, THE IRCd SHALL relay it unchanged.

### Requirement 3: Server password comparison is constant-time

**Finding:** `registration.ts:116`.

#### Acceptance Criteria

1. WHEN a client sends `PASS`, THE IRCd SHALL compare SHA-256 digests of the given and configured passwords with `crypto.timingSafeEqual`.
2. THE IRCd SHALL accept a matching password and reject a non-matching one, including one of a different length, exactly as before.

### Requirement 4: `USER` fields are validated

**Finding:** `registration.ts:158`.

#### Acceptance Criteria

1. WHEN an unregistered client sends `USER` with a username that is empty, longer than 18 bytes, or holds characters outside `A-Z a-z 0-9 . _ ~ -`, THE IRCd SHALL close the connection with `Invalid username` and register nothing.
2. WHEN the real name is longer than 50 UTF-8 bytes or holds a control character (U+0000 to U+001F, U+007F), THE IRCd SHALL close the connection with `Invalid realname`.
3. WHEN a registered client sends `USER`, THE IRCd SHALL reply `462` before any validation.
4. WHEN the fields are valid, THE IRCd SHALL behave as before.

### Requirement 5: Closing a network client is final

**Finding:** `network-client.ts:54-61`, `tcp-transport.ts:58`.

#### Acceptance Criteria

1. WHEN `close(reason)` is called on a network client, THE IRCd SHALL send `ERROR`, end the connection, and destroy the socket if it is still open after the grace period (default 2 seconds).
2. WHEN the socket closes within the grace period, THE IRCd SHALL cancel the destroy timer.
3. WHILE a client is closed, THE IRCd SHALL ignore any bytes received from it and route nothing.

### Requirement 6: Resource limits

**Finding:** `.kiro/steering/security.md` requires rate limits before doing any work.

#### Acceptance Criteria

1. THE IRCd SHALL apply a token bucket per network connection (default capacity 10 lines, one token refilled per second). WHEN a line arrives and the bucket is empty, THE IRCd SHALL quit the client with `Excess Flood` and process no further input from it. Virtual clients are exempt.
2. THE IRCd SHALL accept at most `maxConnections` simultaneous network connections (default 1000) across TCP and WebSocket. WHEN the limit is reached, THE IRCd SHALL send `ERROR :Closing Link: Too many connections` (TCP) or close with code 1013 (WebSocket) and keep no state for the new connection.
3. WHEN a network client has not completed registration within `registrationTimeoutMs` (default 60 seconds), THE IRCd SHALL quit it with `Registration timeout`.
4. THE IRCd SHALL cap the bytes queued for writing per network connection (default 256 KiB). WHEN a send would exceed the cap, THE IRCd SHALL drop the line, destroy the connection, and quit the client with `SendQ exceeded`.
5. THE IRCd SHALL read each limit from an environment variable and reject invalid values at startup.

### Requirement 7: WebSocket Origin allow-list

**Finding:** `ws-transport.ts:35`.

#### Acceptance Criteria

1. WHEN a WebSocket upgrade carries an `Origin` header, THE IRCd SHALL accept it only if it matches an entry of `IRCD_WS_ALLOWED_ORIGINS` (comma-separated, case-insensitive, no path), or the list holds `*`.
2. WHEN an upgrade has no `Origin` header, THE IRCd SHALL accept it (non-browser clients).
3. WHEN the list is unset, THE IRCd SHALL reject every upgrade that carries an `Origin` header.
4. IF an entry is not a valid origin (`scheme://host[:port]`) or `*`, THEN THE IRCd SHALL fail at startup naming the variable.
5. WHEN an upgrade is rejected, THE IRCd SHALL answer HTTP 403 and create no client.
