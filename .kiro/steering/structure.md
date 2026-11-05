---
inclusion: always
---

# Project Structure & IRC Rules

## Monorepo layout

```
apps/
  ircd/            @seance/ircd          IRC server: TCP 6667 (TLS 6697 in prod) + WebSocket
  runner/          @seance/runner        Agent runner: one ACP process per agent, one session per channel
  web/             @seance/web           Retro web client (Next.js, scaffolded in M2)
packages/
  irc-protocol/    @seance/irc-protocol  IrcMessage type, parser, serializer, numerics (no I/O)
  db/              @seance/db            Prisma schema + client
.kiro/
  steering/        Always-on guidance (this folder)
  specs/           Feature specs: requirements.md, design.md, tasks.md
  hooks/           PreToolUse hooks (deny-list)
  agents/          Kiro agent definitions (coder, reviewer, researcher, chanserv)
workspaces/        Per-channel git worktrees (git-ignored, created at runtime)
DESIGN.md          Source of truth for product design
```

## Boundaries

- `packages/irc-protocol` is pure: no sockets, no timers, no Node-specific I/O. Both TCP and WebSocket transports use the same parser.
- `apps/ircd` owns all IRC state (users, channels, modes). Agents connect as in-process virtual clients; there is exactly one source of truth.
- `apps/runner` never writes IRC state directly; it acts through its virtual client like any other user.
- Every new package is named `@seance/<name>`, has its own `package.json` and `tsconfig.json` extending `tsconfig.base.json`.

## IRC protocol rules

- Follow **RFC 2812** (client protocol) for message format, commands and replies; implement only the documented subset.
- Use the **standard numeric replies** (e.g. `001 RPL_WELCOME`, `353 RPL_NAMREPLY`, `403 ERR_NOSUCHCHANNEL`, `433 ERR_NICKNAMEINUSE`, `482 ERR_CHANOPRIVSNEEDED`). Never invent numerics for standard errors.
- Lines end with **CRLF** (`\r\n`). Accept a bare `\n` on input for client tolerance; always emit CRLF.
- A message is at most **512 bytes including CRLF**, measured in UTF-8 bytes, not characters.
- At most 15 parameters; only the last parameter may contain spaces and must then be prefixed with `:`.
- Commands are case-insensitive on input and upper-case on output. Channel names start with `#`.
- Nick and channel comparisons use IRC case-mapping (`rfc1459`).
