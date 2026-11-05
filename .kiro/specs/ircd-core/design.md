# Design: ircd-core

## Overview

The ircd is a single Node.js process that owns all IRC state in memory (persistence arrives in M2/M3 via `@seance/db`). Network bytes flow through a transport, are framed into lines, parsed into `IrcMessage` objects by `@seance/irc-protocol`, and dispatched by a `CommandRouter` to handlers that read and mutate a `ChannelRegistry` and `ConnectionManager`. Replies are serialized back by the same package.

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

## Components

### `@seance/irc-protocol` (packages/irc-protocol)

Pure, I/O-free module.

- `IrcMessage { prefix?, command, params[] }`.
- `parse(line: string): IrcMessage | ParseError` — RFC 2812 grammar; tolerates bare LF; strips CRLF; uppercases command.
- `serialize(msg: IrcMessage): string` — emits CRLF, prefixes the last param with `:` when it contains a space, starts with `:`, or is empty; throws if the result exceeds 512 bytes.
- `LineFramer` — accumulates chunks (Buffer/string), yields complete lines, flags overlong lines (Req 1.1, 1.2).
- `Numerics` — named constants for every numeric used (e.g. `ERR_NICKNAMEINUSE = "433"`).
- `irc_lower(s)` — rfc1459 case-mapping for nick/channel comparison.
- `isValidNick`, `isValidChannel`.

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

- Tracks clients by id and by case-mapped nick (Req 3.3, 11.2).
- Registration state machine: `PASS? → NICK + USER → registered` (Req 3).
- Keep-alive timers per client (Req 4).
- `broadcastToPeers(client, msg)` — sends once to every user sharing a channel (Req 3.9, 11.1).

### `ChannelRegistry`

- `Channel { name, topic?, modes: { moderated }, members: Map<clientId, { op, voice }> }`.
- Creates on first join (creator gets `+o`), deletes when empty (Req 5.1, 5.6).
- Permission helpers: `isOp`, `canSpeak` (respects `+m`) (Req 6.5, 7.3, 9.5, 10.2).

### `CommandRouter`

- Maps uppercase command → handler `(ctx, client, msg) => void`.
- Enforces registration gating (Req 3.7), unknown command (Req 1.5), and `ERR_NEEDMOREPARAMS` via declared minimum params (Req 3.6).
- Handlers are small pure-ish functions over `ConnectionManager` and `ChannelRegistry`, making them unit-testable without sockets.

### Transports

- `TcpTransport` — `node:net` server; one `LineFramer` per socket.
- `WsTransport` — `ws` via Fastify; each text frame is fed to a `LineFramer`, so multiple lines per frame work (Req 2.2).
- Both create a `NetworkClient` implementing `Client` and feed parsed messages to the same router (Req 2.3). Socket close → synthetic `QUIT` (Req 2.4).

### `VirtualClient`

In-process client used by agents (Req 12).

```ts
interface VirtualClient extends Client {
  /** Send a command as this client; goes through CommandRouter. */
  dispatch(msg: IrcMessage): void;
  /** Subscribe to messages the server sends to this client. */
  onMessage(listener: (msg: IrcMessage) => void): () => void;
}
```

### `EventBus`

Typed in-process emitter publishing `irc.message`, `irc.mode`, `irc.kick` (Req 9.8, 10.4). Swappable for Redis pub/sub later.

## Error handling

- Parse errors are dropped silently per Req 1.4 but counted for diagnostics.
- Handler exceptions are caught per message, logged with the command and client id, and never crash the server or other clients.
- `NOTICE` never produces error replies (Req 6.7).

## Correctness properties (property-based tests with fast-check)

| # | Property | Covers |
|---|---|---|
| P1 | **Round-trip:** for every valid `IrcMessage` `m`, `parse(serialize(m))` deep-equals `m`. | Req 1 |
| P2 | **Length bound:** `serialize(m)` is ≤ 512 UTF-8 bytes including CRLF, or throws. | Req 1.3 |
| P3 | **CRLF:** every serialized line ends in exactly one `\r\n` and contains no other CR/LF. | Req 1.3 |
| P4 | **Framing independence:** splitting a byte stream into arbitrary chunks yields the same lines from `LineFramer`. | Req 1.1, 2.2 |
| P5 | **Case-mapping:** `irc_lower` is idempotent and `irc_lower(a) == irc_lower(b)` implies nick collision. | Req 3.3 |
| P6 | **Unique nicks:** after any sequence of NICK/QUIT operations, no two registered clients share a case-mapped nick. | Req 3.3, 11.2 |
| P7 | **Membership consistency:** after any sequence of JOIN/PART/KICK/QUIT, every channel is non-empty and every member is a live client. | Req 5.6, 10.1, 11.1 |
| P8 | **Moderation:** in a `+m` channel, a message from a member without `+o`/`+v` is never delivered. | Req 6.5 |
| P9 | **NAMES split:** every `353` line respects P2 and the union of names equals the member set. | Req 8.2 |

## Testing strategy

- Unit tests for parser, serializer, framer and each command handler (vitest).
- Property tests P1–P9 (fast-check).
- Integration test: two TCP clients register, join `#test`, exchange `PRIVMSG` (M1 exit criterion), plus one WebSocket client in the same channel.
- Manual check: two irssi instances against `localhost:6667`.
