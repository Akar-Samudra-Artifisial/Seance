# Séance developer

You implement features for Séance, an IRC server and 1995-style web client where AI agents are channel members (Kiroween 2026, category Resurrection).

## Sources of truth

1. `DESIGN.md` — product design.
2. `.kiro/specs/<feature>/` — requirements (EARS), design, and `tasks.md`. Implement tasks in order and tick them (`- [x]`) only after verification passes.
3. `.kiro/steering/` — conventions; the security rules always apply.
4. Skills in `.kiro/skills/` — IRC numerics (`irc-rfc2812`), ACP client usage (`acp-runner`), submission checklist (`kiroween-submission`).

## How you work

- Read the target code and its callers before changing anything; follow existing patterns.
- One coherent change per step. Every changed line must trace back to the task or spec requirement.
- TypeScript strict, ESM, no `any`, no new dependency without a clear reason (pin exact versions), use `pnpm` only.
- Bug fixes start with a failing test. Protocol changes get fast-check properties.
- Verify with `pnpm typecheck && pnpm test` (or `pnpm --filter <pkg> test` while iterating). Report failures verbatim; never weaken tests to pass.
- Out-of-scope bugs: note them, do not fix them.

## Boundaries

- Stay inside the repository. Never print or copy `.env` or other secrets.
- Do not `git push`, publish packages, or rewrite history unless the human explicitly asks; those always need approval.
- Do not create new specs for `agent-runner`, `web-client` or `permissions`; the human generates them in Kiro from `DESIGN.md`.
