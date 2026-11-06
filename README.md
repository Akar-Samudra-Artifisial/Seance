# Séance

> **IRC is dead. Hold a séance.**

A 1995-style, mIRC-inspired IRC client and server for commanding a team of AI agents. Every agent is a user in a channel; you run the team with `/op`, `/kick` and `/topic`. Classic clients like irssi and HexChat can connect too.

Built for **Kiroween 2026** (Resurrection category).

**Status:** 🚧 work in progress — see [DESIGN.md](./DESIGN.md) for the full design.

## Repository layout

```
apps/
  ircd/            IRC server (TCP + WebSocket), TypeScript
  runner/          Agent runner (Kiro ACP client)
  web/             Retro web client (Next.js — scaffolded in M2)
packages/
  irc-protocol/    IRC message parser/serializer + property-based tests
  db/              Database access (Prisma + Postgres)
.kiro/
  steering/        Product, tech and structure steering for Kiro
  specs/           Feature specs (ircd-core, ...)
  hooks/           Agent hooks
  agents/          Kiro agent definitions
```

## Development

Requirements: Node.js (see `.nvmrc`) and pnpm (see `packageManager` in `package.json`).

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm dev
```

## ircd configuration

Set through environment variables. Limits apply to network connections; in-process virtual clients are exempt.

| Variable | Default | Meaning |
| --- | --- | --- |
| `IRCD_TCP_PORT` / `IRCD_WS_PORT` | 6667 / 6668 | Listening ports (TCP for classic clients, WebSocket for the web client) |
| `IRCD_HOST` | all interfaces | Bind address |
| `IRCD_SERVER_NAME` | `seance.local` | Server name in prefixes and numerics (hostname-like) |
| `IRCD_SERVER_PASSWORD` | unset | Required `PASS`; unset disables it. No spaces, CR, LF or NUL |
| `IRCD_IDLE_INTERVAL_MS` / `IRCD_PING_TIMEOUT_MS` | 120000 / 60000 | Idle time before `PING`, then time to answer before disconnect |
| `IRCD_MAX_CONNECTIONS` | 1000 | Simultaneous TCP + WebSocket connections |
| `IRCD_FLOOD_BURST` / `IRCD_FLOOD_REFILL_MS` | 10 / 1000 | Token bucket: burst size and ms per refilled line |
| `IRCD_REGISTRATION_TIMEOUT_MS` | 60000 | Time to finish `NICK`/`USER` |
| `IRCD_MAX_WRITE_BUFFER_BYTES` | 262144 | Queued bytes before a slow client is dropped |
| `IRCD_CLOSE_GRACE_MS` | 2000 | Delay before a closing socket is destroyed |
| `IRCD_WS_ALLOWED_ORIGINS` | empty | Comma-separated origins (`https://host[:port]`) or `*`. Empty rejects browser upgrades; clients without an `Origin` header are always accepted |

## Supported commands and numerics

The ircd implements a documented subset of RFC 2812. Commands are case-insensitive on input.

**Commands:** `PASS`, `NICK`, `USER`, `PING`, `PONG`, `QUIT`, `JOIN`, `PART`, `PRIVMSG`, `NOTICE`, `TOPIC`, `NAMES`, `LIST`, `MODE`, `KICK`, `AWAY`, `WHOIS`, `INVITE`.

- `AWAY [:text]` sets or clears an away message. The server advertises `AWAYLEN=200` in `005 RPL_ISUPPORT`; longer text is cut to 200 UTF-8 bytes. A `PRIVMSG` to an away nick is delivered and answered with `301`. `NOTICE` and channel messages never produce `301`.
- `WHOIS [server] <nick>` replies with user, channels, server, extra lines, away and idle information. Only the first nick of a comma-separated list is processed.
- `INVITE <nick> <#channel>` requires channel operator status. Invitations are recorded, but `+i` is not implemented, so they do not restrict joining.

**Numerics:**

| Group | Numerics |
| --- | --- |
| Registration | `001`, `002`, `003`, `004`, `005` |
| Away and WHOIS | `301`, `305`, `306`, `311`, `312`, `317` (idle time and sign-on time), `318`, `319`, `320` |
| Channels | `321`, `322`, `323`, `324`, `331`, `332`, `341`, `353`, `366` |
| MOTD and modes | `221`, `372`, `375`, `376` |
| Errors | `401`, `403`, `404`, `411`, `412`, `417`, `421`, `431`, `432`, `433`, `441`, `442`, `443`, `451`, `461`, `462`, `464`, `472`, `482` |

`320` (`RPL_WHOISSPECIAL`) is not defined in RFC 2812. It is the de facto numeric used by ircu, UnrealIRCd and Ergo for free-text `WHOIS` lines, and Séance uses it to show agent details such as model, tools and credits. Every other numeric above is from RFC 2812.

## License

[MIT](./LICENSE)
