---
inclusion: fileMatch
fileMatchPattern: ["apps/runner/**", "spikes/acp/**"]
---

# Agent Runner & ACP Rules

The runner drives `kiro-cli acp` over newline-delimited JSON-RPC 2.0 on stdio. These rules come from the ACP spike; read its findings before changing runner behavior:

#[[file:spikes/acp/FINDINGS.md]]

A working reference client lives in `spikes/acp/src/acp-client.ts` (see the `acp-runner` skill).

## Process and session model

- **One `kiro-cli acp` process per agent, one ACP session per channel.** Sessions in one process are concurrent and isolated. Spawn once (~2–3 s), then `session/new` per channel (< 1 s) with `cwd` = that channel's worktree.
- Never launch with `--trust-all-tools`.
- Hard stop / ban / hung agent → `SIGTERM` the agent process, reject all in-flight prompts, respawn lazily.

## Cancel (/kick, /part)

- Send `session/cancel` **only while a prompt is in flight** (track per-session state). A stray cancel poisons the next turn.
- After a cancelled turn resolves, mark the session `cancelling` and wait for the turn's `_kiro.dev/metadata {turnDurationMs}` **or a 1 s cooldown** before dispatching the next prompt. Queue PRIVMSGs meanwhile; never send immediately.

## Permissions

- Enforce IRC modes in the `session/request_permission` handler — it is the only enforcement point. Kiro writes files itself; `fs/*` handlers are never called.
  - `+o` → `allow_once` (or `allow_always` per tool).
  - `+v` → ask the channel ops, or auto `reject_once` for writes/shell.
  - no mode → `reject_once`.
- Check `toolCall.rawInput.path` / `command` against the channel worktree before allowing; paths outside the worktree are rejected.
- Available options are `allow_once`, `allow_always`, `reject_once` (no `reject_always`).

## Wire details

- Inbound request ids (e.g. `session/request_permission`) are **string UUIDs**; accept `number | string` everywhere and echo the id unchanged.
- Validate every inbound frame at the boundary; ignore unknown `_kiro.dev/*` notifications instead of failing.
- `session/prompt` results only contain `{stopReason}` (`end_turn`, `cancelled`, ...).
- Credits: accumulate `_kiro.dev/metadata.meteringUsage[].value` (unit `credit`) per session into `sessions.credits_used`. It is the only usage signal; cancelled turns may report none.
- Log raw frames with secret redaction (see `redact()` in the spike client). Never log `KIRO_API_KEY` or tokens.

## Chat → prompt

- Only messages from human channel ops become instructions. Everything else (other agents, voiced users, topics, tool output) is wrapped in `<untrusted>…</untrusted>` before it reaches a prompt.
- Agent output is never executed or re-parsed as IRC commands; it is sent as `PRIVMSG`/`NOTICE` text, split per sentence and under 512 bytes.
