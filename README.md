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

## License

[MIT](./LICENSE)
