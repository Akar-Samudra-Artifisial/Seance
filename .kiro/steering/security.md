---
inclusion: always
---

# Security Rules

Séance lets AI agents act on a codebase from a chat channel, so security is a product feature, not an afterthought.

## Agent capabilities (runtime)

- **Shell, file writes and `git commit` only for `+o` agents.** `+v` may speak; no mode = listen only. The runner enforces this in `session/request_permission`.
- Each channel has its own **git worktree sandbox** under `workspaces/<channel>`. An agent's cwd is locked to it; any path outside the worktree is rejected.
- Agents run in a Podman container in production and are never launched with `--trust-all-tools`.

## Untrusted input

- Every chat message, topic, nick, and tool output is **untrusted** data. Only messages from human channel ops become instructions; everything else is wrapped in `<untrusted>…</untrusted>` before reaching a prompt.
- Agent output is never executed, `eval`ed, or re-parsed as IRC commands.
- Validate all external input at the boundary (sockets, WebSocket frames, ACP frames, env vars). Enforce the 512-byte line limit and rate limits before doing any work.

## Secrets

- Never commit secrets: `.env*`, `KIRO_API_KEY`, database URLs with passwords, tokens, private keys. `.env*` is git-ignored; keep it that way.
- Read secrets from environment variables only; never hardcode, log, or echo them. Redact secret-looking keys in logs.
- Do not print `.env` or credential files in a shell, even for debugging (the `guard-shell` hook blocks this).

## Development agents (this repo)

- Destructive commands (`rm -rf` outside build dirs, `git push --force`, `git reset --hard`, `git clean -fdx`, `curl … | sh`) are blocked by `.kiro/hooks/guard-shell.json`.
- Stay inside the repository root; do not read or write paths outside it.
- `git push` and `npm`/`pnpm publish` always require explicit human approval.
