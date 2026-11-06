# Design: ircd-core

## Overview

The ircd is a single Node.js process that owns all IRC state in memory (persistence arrives in M2/M3 via `@seance/db`). Network bytes flow through a transport, are framed into lines, parsed into `IrcMessage` objects by `@seance/irc-protocol`, and dispatched by a `CommandRouter` to handlers that read and mutate a `ChannelRegistry` and `ConnectionManager`. Replies are serialized back by the same package.

The exit criterion for M1 is that two irssi clients can register, join a channel and chat. Agent integration (the ACP runner) is out of scope, but the server exposes a `VirtualClient` interface so agents can later connect in-process through the same router, permission checks and boundary validation as network clients.

```
            ┌────────────── apps/ircd ───────────────────────────────┐
 irssi ─TCP─▶ TcpTransport ─┐                                        │
                            │  lines   ┌──────────────┐  IrcMessage  │
 web  ──WS──▶ WsTransport ──┼─────────▶│ LineFramer + │─────────────▶│ CommandRouter
                            │          │ parse()      │              │   │  handlers: PASS NICK USER PING PONG
 agent ─────▶ VirtualClient ┘ (IrcMessage directly) ──────────────────▶   │  JOIN PART PRIVMSG NOTICE TOPIC
            │                                                        │   │  NAMES LIST MODE KICK QUIT
            │   ┌───────────────────┐   ┌──────────────────┐         │   ▼
            │   │ ConnectionManager │◀─▶│ ChannelRegistry  │◀────────┘ state
            │   └─────────┬─────────┘   └──────────────────┘
            │             │ serialize() + send()
            │             ▼
            │        Client.send()  ──▶ transport / virtual inbox
            │   EventBus: irc.message, irc.mode, irc.kick (in-process; Redis later)
            └────────────────────────────────────────────────────────┘
```

All transports — TCP, WebSocket and the in-process virtual client — share a single parser and command router. The only thing that differs per transport is how bytes become lines (TCP and WebSocket) or how an `IrcMessage` is submitted directly (virtual client); once an `IrcMessage` exists, routing, permission checks, numerics and broadcasts are identical (Req 2.3, 12.2).

## Architecture

### Pipeline per transport

1. **Bytes → lines.** TCP and WebSocket feed raw chunks to a per-connection `LineFramer` that splits on CRLF, tolerates a bare LF, discards empty lines, and flags any line over the 512-byte limit (Req 1.1). The virtual client skips this stage and submits an `IrcMessage` directly, but that message still passes the same boundary validation (Req 12.4).
2. **Line → `IrcMessage`.** `parse()` applies the RFC 2812 grammar and returns a `ParseError` sentinel for lines that do not conform or that carry more than 15 parameters; the router drops those silently (Req 1.5).
3. **Dispatch.** `CommandRouter` matches the uppercased command (Req 1.7), enforces registration gating (Req 3.7) and minimum-parameter counts (`461 ERR_NEEDMOREPARAMS`), then calls the handler with a context holding `ConnectionManager`, `ChannelRegistry` and the `EventBus`.
4. **Reply.** Handlers build `IrcMessage` replies and broadcasts; `serialize()` emits CRLF and enforces the 512-byte output bound (Req 1.3, 1.4).

### State ownership

`apps/ircd` owns all IRC state in memory. `ConnectionManager` owns clients and nicks; `ChannelRegistry` owns channels, membership and modes. Handlers are the only writers of this state, so there is a single source of truth shared by network and virtual clients.

## Components and Interfaces

### `@seance/irc-protocol` (packages/irc-protocol)

Pure, I/O-free module. No sockets, timers or Node-specific I/O, so both transports and the virtual client share it.

- `IrcMessage { prefix?, command, params[] }`.
- `parse(line: string): IrcMessage | ParseError` — RFC 2812 grammar; tolerates bare LF; strips CRLF; uppercases the command; returns a `ParseError` sentinel (never throws) for malformed input or more than 15 params.
- `serialize(msg: IrcMessage): string` — emits exactly one trailing CRLF, prefixes the last param with `:` when it contains a space, starts with `:`, or is empty; throws if the result exceeds 512 bytes including CRLF measured in UTF-8.
- `LineFramer` — accumulates chunks (Buffer/string), yields complete lines on CRLF or bare LF, discards empty lines, and flags overlong lines so the transport can emit `417 ERR_INPUTTOOLONG` while keeping the connection open (Req 1.1, 1.2).
- `Numerics` — named constants for every numeric used, including `RPL_WELCOME 001`, `RPL_YOURHOST 002`, `RPL_CREATED 003`, `RPL_MYINFO 004`, `RPL_ISUPPORT 005`, `RPL_MOTDSTART 375`, `RPL_MOTD 372`, `RPL_ENDOFMOTD 376`, and the error numerics listed per handler below.
- `irc_lower(s)` — rfc1459 case-mapping for nick/channel comparison (`{}|^` are the lowercase of `[]\~`).
- `isValidNick`, `isValidChannel`.

### `isValidNick`

Enforces Req 3.4: a nick is valid when it is non-empty, at most 30 characters, begins with a letter, and otherwise contains only letters, digits, and the characters `-`, `[`, `]`, `\`, `` ` ``, `^`, `{`, `}`, `_`. The `NICK` handler maps a failure here to `432 ERR_ERRONEUSNICKNAME` and a missing parameter to `431 ERR_NONICKNAMEGIVEN`.

### `Client` (apps/ircd)

Common abstraction over all connection kinds.

```ts
interface Client {
  readonly id: string;
  nick?: string;
  user?: string;
  registered: boolean;
  away?: string;
  send(msg: IrcMessage): void;
  close(reason: string): void;
}
```

### `ConnectionManager`

- Tracks clients by id and by case-mapped nick (Req 3.3, 11.5).
- Registration state machine: `PASS? → NICK + USER → registered` (Req 3). A duplicate `PASS` or `USER` after registration returns `462 ERR_ALREADYREGISTRED` and leaves the existing registration state unchanged (Req 3.2, 3.8).
- Keep-alive timers per client (Req 4): the idle timer fires a server `PING` after the idle interval (default 120 s) measured from the last complete message received, and a missing `PONG` within the ping timeout (default 60 s) closes the connection with reason `Ping timeout`. Receiving any complete message resets the idle timer.
- `broadcastToPeers(client, msg)` — sends once to every client sharing at least one channel with the subject, used for `NICK` changes and `QUIT` so each peer sees exactly one copy (Req 3.10, 11.1, 11.2).
- Releases a nick on connection close so it becomes reusable under rfc1459 case-mapping (Req 11.5).

### `ChannelRegistry`

- `Channel { name, topic?, modes: { moderated }, members: Map<clientId, { op, voice }> }`.
- Creates a channel on first join, granting the creator `+o` (Req 5.1); deletes the channel when the last member leaves, discarding its topic and mode state (Req 5.8).
- Permission helpers: `isOp`, `isMember`, `canSpeak` (respects `+m`: only `+o`/`+v` members may speak in a moderated channel) (Req 6.6, 7.3, 9.6, 10.2).

### `CommandRouter`

- Maps uppercase command → handler `(ctx, client, msg) => void` (Req 1.7).
- Enforces registration gating: an unregistered client sending anything other than `PASS`, `NICK`, `USER`, `PING`, `PONG` or `QUIT` gets `451 ERR_NOTREGISTERED` (Req 3.7); a registered client sending an unknown command gets `421 ERR_UNKNOWNCOMMAND` (Req 1.6).
- Enforces `461 ERR_NEEDMOREPARAMS` via each handler's declared minimum parameter count (Req 3.6).
- Handlers are small pure-ish functions over `ConnectionManager` and `ChannelRegistry`, making them unit-testable without sockets.

#### Handler responsibilities

- **Registration (`PASS`/`NICK`/`USER`).** Errors `464` (password mismatch, then close), `462` (already registered on duplicate `PASS` or `USER`), `431` (no nick given), `432` (erroneous nick), `433` (nick in use, rfc1459 compare). On completed registration the welcome burst sends numerics `001`, `002`, `003`, `004`, `005` in that order, followed by MOTD numerics `375`, `372`, `376` (Req 3.9). A registered client's nick change broadcasts `NICK` to the client and every peer (Req 3.10).
- **Keep-alive (`PING`/`PONG`).** `PING <token>` replies `PONG <server> :<token>`; `PING` without a token replies `461 ERR_NEEDMOREPARAMS` (Req 4.1, 4.2). Idle and timeout timers live in `ConnectionManager` (Req 4.3, 4.4).
- **`JOIN`.** Splits a comma list and processes each channel in order; a failure on one channel does not stop the rest (Req 5.9). A name not beginning with `#` yields `403 ERR_NOSUCHCHANNEL` for that name (Req 5.4). Joining a channel the client is already in is a silent no-op (Req 5.5). A successful join broadcasts `JOIN` to all members including the joiner (Req 5.2) and sends the joiner the topic (`332`/`331`) and names (`353` then `366`) (Req 5.3). Missing channel parameter → `461` (Req 5.10).
- **`PART`.** Broadcasts `PART` with the optional reason to all members including the leaver (Req 5.7); `442 ERR_NOTONCHANNEL` when the client is not in the named channel (Req 5.6); comma list processed in order with failure isolation (Req 5.9); missing channel parameter → `461` (Req 5.10); empty channels are removed with their topic and mode state discarded (Req 5.8).
- **`PRIVMSG`.** Channel delivery to every member except the sender (Req 6.1); private delivery only to the named nick (Req 6.2). Errors: `401` (no such nick, no delivery), `403` (no such channel), `404` (non-member or `+m` without `+o`/`+v`), `411` (no recipient), `412` (no text to send) (Req 6.3–6.8). When the private target is marked away, the sender also receives `301 RPL_AWAY` and the message is still delivered (Req 6.11).
- **`NOTICE`.** Uses the same delivery and permission path as `PRIVMSG` but suppresses every error reply for any failure (Req 6.9, 6.10).
- **`TOPIC`.** Query (no topic text) replies `332`/`331` for an existing channel (Req 7.1); an operator setting a topic replaces it and broadcasts `:nick!user@host TOPIC #ch :text` to all members (Req 7.2); a non-operator member gets `482 ERR_CHANOPRIVSNEEDED` with no change (Req 7.3); a non-member gets `442 ERR_NOTONCHANNEL` (Req 7.4); a non-existent channel gets `403 ERR_NOSUCHCHANNEL` (Req 7.5); a missing channel parameter gets `461 ERR_NEEDMOREPARAMS` (Req 7.6).
- **`NAMES`.** For an existing channel, emits one or more `353 RPL_NAMREPLY` lines prefixing each operator with `@`, each voiced member with `+`, no prefix otherwise, then a single `366 RPL_ENDOFNAMES`. For a non-existent or empty channel, emits only `366` with no `353` (Req 8.2). `353` output is split across multiple lines when it would exceed 512 bytes including CRLF, never splitting an individual nick across two lines (Req 8.1, 8.3).
- **`LIST`.** One `322 RPL_LIST` per visible channel (name, visible member count as a non-negative integer, topic) then a single `323 RPL_LISTEND`; when no visible channels exist, only `323` is sent with no `322` (Req 8.4, 8.5).
- **`MODE`.** Validation precedence guarantees no state change when a request is rejected: `403` for an unknown channel; `482` when the sender is not a channel operator; `472 ERR_UNKNOWNMODE` for a mode character other than `o`/`v`/`m`; `461` for an `o`/`v` change with no target nick; `441 ERR_USERNOTINCHANNEL` when the target nick is not a member (Req 9.5–9.9). A successful `+o`/`-o`, `+v`/`-v` or `+m`/`-m` broadcasts a `MODE` message whose origin prefix is the requesting operator and whose arguments echo the change, and publishes an `irc.mode` event (Req 9.1–9.3, 9.10). A bare `MODE #ch` query replies `324 RPL_CHANNELMODEIS` with the active channel modes (Req 9.4).
- **`KICK`.** Errors in precedence: `403` for an unknown channel, `442` when the kicker is not a member, `482` when the kicker is not an operator, `441` when the target is not in the channel, `461` for fewer than two parameters (Req 10.2, 10.3, 10.5, 10.6, 10.7). On success it broadcasts `KICK` to all members including the target, then removes the target, using the kicker's nickname as the reason when none is supplied (Req 10.1), and publishes an `irc.kick` event (Req 10.4).
- **`QUIT`.** Broadcasts a `QUIT` carrying the given reason, or `Client Quit` when none is supplied, exactly once to every peer excluding the quitter (Req 11.1, 11.2); then removes the client from every channel (Req 11.3), closes the connection (Req 11.4) and releases the nick for rfc1459 reuse (Req 11.5). The ordering is broadcast → remove from channels → close → release nick.

### Transports

- `TcpTransport` — `node:net` server on a configurable port (default 6667); one `LineFramer` per socket (Req 2.1).
- `WsTransport` — `ws` via Fastify; each text frame is fed to a `LineFramer`, so zero or more complete lines per frame work and an incomplete trailing line is buffered until later frames complete it (Req 2.2, 2.4).
- Both construct a `NetworkClient` implementing `Client` and feed parsed messages to the same router, producing identical parse and routing results regardless of transport (Req 2.3). A socket close is processed as a synthetic `QUIT` describing the closure (Req 2.5).

### `VirtualClient`

In-process client used by agents (Req 12). It is indistinguishable from a network client to peers across JOIN, PART, QUIT, MODE, PRIVMSG, NOTICE, `353 RPL_NAMREPLY`, WHOIS output and `@`/`+` prefixes (Req 12.3).

```ts
interface VirtualClient extends Client {
  /** Send a command as this client; routed through CommandRouter with the
   *  same permission checks and boundary validation as network input.
   *  Rejects (and reports to the caller) a malformed IrcMessage or one whose
   *  serialized form would exceed 512 bytes including CRLF (Req 12.4). */
  dispatch(msg: IrcMessage): void;
  /** Register the handler that receives each server message directed to this
   *  client, one IrcMessage per invocation (Req 12.1). */
  onMessage(listener: (msg: IrcMessage) => void): () => void;
}
```

`dispatch` runs the submitted `IrcMessage` through the same boundary validation that network input passes: a malformed message, or one whose serialized form would exceed the 512-byte line limit, is rejected, is not routed, and the rejection is surfaced to the caller (Req 12.4). This reuses `serialize()`'s length check rather than duplicating it.

### `EventBus`

Typed in-process emitter publishing `irc.message`, `irc.mode`, `irc.kick` (Req 9.10, 10.4). Swappable for Redis pub/sub later.

## Data models

```ts
// @seance/irc-protocol
type IrcMessage = {
  readonly prefix?: string;
  readonly command: string;      // uppercased on parse
  readonly params: readonly string[]; // last may contain spaces
};
type ParseError = { readonly kind: "parse-error"; readonly reason: string };

// apps/ircd
type Membership = { op: boolean; voice: boolean };
type Channel = {
  readonly name: string;         // starts with '#'
  topic?: string;
  modes: { moderated: boolean };
  members: Map<string, Membership>; // keyed by Client.id
};
type ServerConfig = {
  tcpPort: number;        // default 6667
  wsPort: number;
  serverName: string;
  serverPassword?: string;
  idleIntervalMs: number; // default 120_000
  pingTimeoutMs: number;  // default 60_000
};
```

Nicks and channel names are compared via `irc_lower` (rfc1459). `ConnectionManager` keys its nick index by the case-mapped form; `ChannelRegistry` keys channels by the case-mapped name.

## Correctness Properties

These properties are validated with property-based tests using fast-check.

A property is a characteristic that should hold across all valid executions of the system — a formal statement of what the system should do, bridging human-readable requirements and machine-verifiable tests.

| # | Property | Covers |
|---|---|---|
| P1 | **Round-trip:** for every valid `IrcMessage` `m`, `parse(serialize(m))` deep-equals `m`. | Req 1 |
| P2 | **Length bound:** `serialize(m)` is ≤ 512 UTF-8 bytes including CRLF, or throws. | Req 1.3, 1.4 |
| P3 | **CRLF:** every serialized line ends in exactly one `\r\n` and contains no other CR/LF. | Req 1.3 |
| P4 | **Framing independence:** splitting a byte stream into arbitrary chunks yields the same lines from `LineFramer`. | Req 1.1, 2.2 |
| P5 | **Case-mapping:** `irc_lower` is idempotent and `irc_lower(a) == irc_lower(b)` implies nick collision. | Req 3.3 |
| P6 | **Unique nicks:** after any sequence of NICK/QUIT operations, no two registered clients share a case-mapped nick, and a released nick is reusable. | Req 3.3, 11.5 |
| P7 | **Membership consistency:** after any sequence of JOIN/PART/KICK/QUIT, every channel is non-empty and every member is a live client. | Req 5.8, 10.1, 11.3 |
| P8 | **Moderation:** in a `+m` channel, a message from a member without `+o`/`+v` is never delivered. | Req 6.6 |
| P9 | **NAMES split:** every `353` line respects P2, no nick is split across lines, and the union of names equals the member set. | Req 8.1, 8.3 |

Edge cases covered by the generators behind these properties include bare-LF line endings, multi-byte UTF-8 nicks and text, comma-separated multi-channel JOIN/PART with a failing element, and `353` member lists long enough to force a split.

### Property 1: Parse/serialize round-trip

For any valid `IrcMessage` `m`, `parse(serialize(m))` deep-equals `m`.

**Validates: Requirements 1.1, 1.3, 1.5**

### Property 2: Serialized length bound

For any valid `IrcMessage` `m`, `serialize(m)` is at most 512 bytes including the terminating CRLF measured in UTF-8, or it throws.

**Validates: Requirements 1.3, 1.4**

### Property 3: CRLF termination

For any valid `IrcMessage` `m`, `serialize(m)` ends in exactly one `\r\n` and contains no other CR or LF character.

**Validates: Requirements 1.3**

### Property 4: Framing independence

For any byte stream and any partition of that stream into chunks, feeding the chunks to `LineFramer` yields the same sequence of lines as feeding the whole stream at once.

**Validates: Requirements 1.1, 2.2**

### Property 5: Case-mapping idempotence and collision

For any nick string `a`, `irc_lower(a)` equals `irc_lower(irc_lower(a))`, and for any two nicks `a` and `b`, `irc_lower(a) == irc_lower(b)` if and only if the two nicks collide under rfc1459 case-mapping.

**Validates: Requirements 3.3**

### Property 6: Unique and reusable nicks

For any sequence of NICK and QUIT operations, no two registered clients share a case-mapped nick, and a nick released by a QUIT is available for a subsequent NICK under rfc1459 case-mapping.

**Validates: Requirements 3.3, 11.5**

### Property 7: Membership consistency

For any sequence of JOIN, PART, KICK and QUIT operations, every channel that exists is non-empty, every member references a live client, and a channel whose last member leaves no longer exists.

**Validates: Requirements 5.8, 10.1, 11.3**

### Property 8: Moderation

For any moderated (`+m`) channel and any member of it, a `PRIVMSG` from that member is delivered to other members if and only if the member has `+o` or `+v`.

**Validates: Requirements 6.6**

### Property 9: NAMES split integrity

For any channel and its member set, every emitted `353 RPL_NAMREPLY` line is at most 512 bytes including CRLF measured in UTF-8, no individual nick is split across two lines, and the union of nicks across all `353` lines equals the channel's member set.

**Validates: Requirements 8.1, 8.3**

## Error handling

- Parse errors and lines carrying more than 15 params are dropped silently per Req 1.5 but counted for diagnostics.
- Overlong input lines (> 512 bytes including CRLF) are discarded with `417 ERR_INPUTTOOLONG` and the connection stays open (Req 1.2).
- Handler exceptions are caught per message, logged with the command and client id, and never crash the server or other clients.
- `NOTICE` never produces any error reply; any failure is suppressed (Req 6.9).
- `MODE` and `KICK` validate before mutating: a rejected request produces its error numeric and leaves all channel and member state unchanged (Req 9.5–9.9, 10.2–10.3).
- A malformed or overlong `IrcMessage` submitted by a `VirtualClient` is rejected via the same boundary validation as network input, is not routed, and the rejection is reported to the caller (Req 12.4).
- Untrusted input (nicks, topics, message text) is validated at the boundary before any work; the 512-byte line limit is enforced before parsing.

## Testing strategy

- **Unit tests** (vitest) for the parser, serializer, framer, `isValidNick`/`isValidChannel`, and each command handler: registration error numerics and welcome/MOTD ordering (`001`–`005`, `375`/`372`/`376`), `PING` without a token, JOIN/PART edge cases (bad name, already-member no-op, empty-channel removal, multi-channel failure isolation), PRIVMSG error replies and the away `301` path, NOTICE silence, TOPIC permissions and missing-channel errors, NAMES on empty channel, MODE validation precedence, KICK precedence and default reason, QUIT default reason and ordering.
- **Property tests** P1–P9 (fast-check), each configured for a minimum of 100 iterations and tagged with its design property, for example `// Feature: ircd-core, Property P1: parse(serialize(m)) deep-equals m`. Each property test references the property it implements.
- **Integration test:** two TCP clients register, join `#test`, exchange `PRIVMSG` (the M1 exit criterion), plus one WebSocket client in the same channel to confirm transport parity (Req 2.3).
- **Virtual client parity test:** a `VirtualClient` that joins and messages appears identical to peers to a network client, and a malformed/overlong submission is rejected and reported (Req 12.3, 12.4).
- **Manual check:** two irssi instances against `localhost:6667`.
