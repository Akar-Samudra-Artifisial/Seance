# Spike: driving `kiro-cli acp` from Node.js — findings

**Date:** 2026-11-06 · **kiro-cli:** 2.22.0 (engine v2, default) · **Node:** 26.7.0 · **Model:** `claude-haiku-5.5` (0.06x credits)

**Verdict:** the biggest Séance risk is retired. A ~200-line dependency-free JSON-RPC client (`src/acp-client.ts`)
drives the full lifecycle: initialize → session/new → streamed session/prompt → session/cancel → session reuse,
with several sessions multiplexed in one process. One sharp edge: reusing a session right after a cancel (see S5).

Run it: `pnpm --filter @seance/spike-acp spike` (Node 26 strips types natively; no tsx needed).
`SPIKE_ONLY=S5` re-runs S1+S2+S5 only. Raw redacted JSON-RPC logs and `results*.json` land in `out/` (gitignored).

## Results

| # | Scenario | Result | Latency / key numbers |
|---|---|---|---|
| 1 | spawn `kiro-cli acp --model …` + `initialize` (no `--agent`) | OK | spawn→initialize result **1.7–3.1 s**; `protocolVersion: 1`, `authMethods: []` |
| 1b | `--agent spike` from `spikes/acp/.kiro/agents/spike.json` (process cwd) | OK | init 3.5 s, session/new 763 ms, `currentModeId: "spike"`, pong 3.3 s |
| 2 | `session/new {cwd: <git-init temp dir>, mcpServers: []}` | OK | **0.8–1.0 s**; returns `sessionId`, `modes`, `models` |
| 3 | prompt "Reply with exactly: pong" | OK | first chunk 3.4 s, total 3.4 s, `stopReason: end_turn`, 1 chunk |
| 4 | two sessions in one process, prompts sent concurrently | OK | parallel pair 2.5 s / 2.1 s (single prompts 1.7–2.5 s) → truly concurrent; context isolated (A → `ALPHA-7`, B → `BRAVO-9`) |
| 5 | `session/cancel` 1 s after first chunk, then reuse session | OK (with 1 s settle) | cancel → prompt resolves **4 ms**, `stopReason: "cancelled"`; follow-up pong 2.6 s `end_turn` |
| 5′ | same, follow-up sent 0 ms after cancelled turn resolved | **Fail** | follow-up answered `stopReason: "cancelled"` in 2 ms without running |
| 6a | write `hello.txt`, answer `allow_once` | OK | 6.7 s; file created in session cwd, content `hi`; nothing written outside temp dir |
| 6b | same, answer `reject_once` | OK | 8.8 s; file not created; model reports "write operation was denied", `end_turn` |
| 7 | SIGTERM mid-prompt | OK | exit **1 ms** after kill (`signal: SIGTERM`); pending prompt rejected by our client; 1 child process, no leftovers/zombies after 1.5 s |

Prompts used: 15 (11 full run + 2 + 2 S5 re-runs). Metered credits: **≈0.57** total, almost all from the first full run
(each pong ≈0.002–0.01; tool-use turns cost most).

## Observed wire traffic

- Client → agent: `initialize`, `session/new`, `session/prompt`, notification `session/cancel`.
- Agent → client notifications: `session/update` with `sessionUpdate` ∈ `agent_message_chunk`, `agent_thought_chunk`,
  `tool_call`, `tool_call_update`; Kiro extensions `_kiro.dev/metadata` (`contextUsagePercentage`, `effort`,
  `turnDurationMs`, `meteringUsage: [{value, unit: "credit"}]`), `_kiro.dev/session/update` (`tool_call_chunk`),
  `_kiro.dev/commands/available`, `_kiro.dev/subagent/list_update`.
- Agent → client requests: only `session/request_permission` (id is a **string UUID**, not a number). Options:
  `allow_once`, `allow_always`, `reject_once` (no `reject_always`). `toolCall.rawInput` carries `command`, `path`,
  `content`; `_meta.trustOptions` suggests `runtime_write_paths` patterns.
- **No `fs/read_text_file` / `fs/write_text_file`** although the client advertised `fs` capabilities: Kiro writes files
  itself. Client-side path guards in fs handlers are therefore *not* an enforcement point.
- `session/prompt` result contains only `{stopReason}`; usage arrives via `_kiro.dev/metadata` (no metering seen for
  cancelled turns).

## Limitations

- Haiku streams in large bursts (300 numbers arrived within ~30 ms) and starts with thought chunks; "first chunk" in S5
  was a thought chunk, so no answer text streamed before the cancel.
- Cancel-then-reuse race: a late `session/cancel` also aborts the *next* prompt of that session (run 1: a timer fired
  after the turn ended and cancelled the follow-up in 441 ms).
- `kiro-cli` stays logged in via IAM Identity Center on this machine; headless/server auth (`KIRO_API_KEY`) not tested.
- Engines v1/v3, `loadSession`, `session/set_mode` / model switching, MCP servers, and the `terminal` capability not tested.

## Recommendations for `apps/runner`

1. **One process per agent, one session per channel** (as DESIGN.md says) is confirmed: sessions are concurrent and
   isolated. Spawn cost (~2–3 s) is paid once per agent; session/new is < 1 s.
2. **/kick = `session/cancel`** + mark the session `cancelling`; resolve the IRC action when the prompt returns
   `cancelled` (≈ms). Queue new PRIVMSGs for that session and dispatch only after the cancelled turn's
   `_kiro.dev/metadata {turnDurationMs}` arrives or a ~1 s settle delay — never immediately. Never send a cancel
   unless a prompt is in flight (track per-session state), or it poisons the next turn.
3. **Ban / hard stop / hung agent = SIGTERM** of the agent process: instant and clean; reject all in-flight prompts and
   respawn lazily.
4. **Permissions by channel mode:** handle `session/request_permission` in the runner — `+o` → `allow_once`
   (or `allow_always` per tool), `+v` → ask the channel / auto `reject_once` for writes, no mode → `reject_once`.
   Enforce worktree confinement on `toolCall.rawInput.path` there (and via `.kiro` hooks), not in fs handlers; never
   launch with `--trust-all-tools`.
5. **Credits:** accumulate `_kiro.dev/metadata.meteringUsage` per session into `sessions.credits_used`; this is the
   only usage signal.
6. Validate every inbound frame at the boundary (ids may be number or string; ignore unknown `_kiro.dev/*`
   notifications), and log raw frames with redaction as done here.
7. No SDK needed: newline-delimited JSON-RPC is trivial; a hand-written client keeps the `AgentHarness` small.
   (`@agentclientprotocol/sdk` 2.4.0 exists on npm if typed schemas are wanted later.)
