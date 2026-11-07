---
inclusion: always
---

# Tech Stack & Conventions

## Stack

- **Language:** TypeScript (strict), ESM only (`"type": "module"`), Node.js version from `.nvmrc`.
- **Monorepo:** pnpm workspaces + Turborepo. Use `pnpm` only — never npm or yarn.
- **ircd:** Fastify + `ws`, custom IRC parser from `@seance/irc-protocol`.
- **runner:** Kiro ACP client (`kiro-cli acp --agent <name>`, JSON-RPC over stdio) behind an `AgentHarness` interface.
- **web:** Next.js 16, Tailwind, Zustand.
- **Data:** Postgres via Prisma (`@seance/db`), Redis for pub/sub and rate limiting.
- **Deploy:** Podman (`compose.yaml`) + Caddy for TLS.

## Conventions

- `tsconfig.base.json` is strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`). Do not loosen it per package.
- Use `NodeNext` module resolution for Node packages; relative imports include the `.js` extension.
- No `any`. Prefer `readonly` types and `const`. Never mutate inputs.
- Errors must say what failed and why; never swallow errors silently.
- Validate all external input at the boundary (sockets, WebSocket frames, ACP messages, env vars).
- No hardcoded secrets, hosts or credentials — use environment variables.

## Testing

- **vitest** for unit and integration tests (`pnpm test` runs all via turbo).
- **fast-check** for property-based tests, especially the protocol round-trip `parse(serialize(m)) == m`.
- Fixing a bug starts with a failing test that reproduces it.

## Dependencies

- Do not add a new dependency without a clear reason; prefer the standard library and existing packages.
- Pin exact versions in `package.json`.

## Commands

```sh
pnpm install
pnpm build | pnpm typecheck | pnpm test | pnpm lint | pnpm dev
pnpm --filter @seance/irc-protocol test
```
