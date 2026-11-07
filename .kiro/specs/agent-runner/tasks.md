# Implementation Plan: agent-runner

## Overview

Build `apps/runner` (`@seance/runner`) bottom-up. Task 0 holds two spikes: S8 records how `kiro-cli acp --agent <name>` resolves agent files (done) and S9 (done) records which workspace configuration (steering, AGENTS.md, hooks, MCP, skills) `kiro-cli acp` loads from the session cwd; Task 0 blocks everything else. Then come the package scaffold, the pure building blocks (ports, config, clock, log, registry, ACP frames and client), and the Fake_Agent fixture, which is built early because every later test runs against it. The harnesses, worktrees, session reducer, Session, prompt builder, output streaming, permissions, credits and WHOIS follow, each with its property test next to the code. Then come the SessionManager, invite handling, Exorcism, hung-agent handling, shutdown and the composition root. The only `apps/ircd` change (design D1: publish `irc.message`) and the wiring (`runner-wiring.ts`, `index.ts`) come next, followed by integration tests against the Fake_Agent with an in-process ircd, one opt-in e2e test, the README section and the demo checklist. Properties P1–P12 from the design are placed next to the code they validate. Every Fake_Agent-based test uses an injected `Clock` or fake timers, never a wall-clock sleep.

## Tasks

- [x] 0. Task 0: spike on agent file resolution (blocks every other task)
  - [x] 0.1 Verify how `kiro-cli acp --agent <name>` resolves agent files when the process cwd differs from the session cwd
    - Use `spikes/acp/src/acp-client.ts`: spawn once with process cwd = a directory holding `.kiro/agents/<name>.json`, then `session/new` with a different `cwd` (a temporary directory); repeat with the agent file only in the session cwd
    - Record the observed behaviour, the exact commands and the date in `spikes/acp/FINDINGS.md` (new section "S8: agent file resolution")
    - Needs the real `kiro-cli` and may spend credits; keep it to a handful of short prompts and do not log `KIRO_API_KEY`
    - The spawn strategy stays unconditional (process cwd = agents directory, worktree only as the ACP session cwd); the finding is documentation and does not change it
    - _Requirements: 1.9, 1.10_

  - [x] 0.2 Spike S9: check whether `kiro-cli acp` loads workspace configuration from the ACP session cwd
    - `spikes/acp/src/s9-session-cwd-config.ts` and the `s9` script (next to `s8`), reusing `spikes/acp/src/acp-client.ts`: six scenarios (steering, AGENTS.md, hooks, MCP with `includeMcpJson` false and true, skills), one `kiro-cli acp --agent <profile> --model claude-haiku-5.5` process each with process cwd = a temp agents directory and `session/new` cwd = a fresh `git init` temp worktree; one prompt "Say OK." each (six in total, Haiku only), markers in a separate temp dir, never `--trust-all-tools`
    - Result recorded in `spikes/acp/FINDINGS.md` (section "S9: workspace config from the session cwd") and `docs/KIRO_USAGE.md`: `AGENTS.md` and `.kiro/skills` in the session cwd are loaded; steering, hooks and MCP were not
    - Follow-up applied for what was loaded: Requirement 4 criteria 12–14 (sparse-checkout excluding every `AGENTS.md` and `.kiro/` at every depth, whole-tree scan on ensure and before every prompt) and Requirement 8 criteria 14–16 (protected paths), design Worktrees steps 4–5, tasks 7.3, 7.4, 9.3, 9.5, 12.1–12.4
    - _Requirements: 1.9, 4.12_

  - [x] 0.3 Spike S10: nested config and mid-session `AGENTS.md`
    - `spikes/acp/src/s10-nested-config.ts` and the `s10` script (next to `s9`): four Haiku prompts — nested `docs/deep/AGENTS.md`, nested `packages/x/.kiro/skills/.../SKILL.md`, and an `AGENTS.md` created by the agent in turn 1 with a "Say OK." turn 2 in the same session
    - Result in `spikes/acp/FINDINGS.md` section "S10: nested config and mid-session AGENTS.md": nested copies were not loaded at session start; the mid-session result is confounded because the code was in the turn 1 prompt (no proof either way)
    - _Requirements: 4.12, 4.13, 4.14, 8.14_

- [x] 1. Package scaffold (`apps/runner`)
  - [x] 1.1 Set up the package, scripts and turbo wiring
    - `package.json`: name `@seance/runner`, `type: module`, dependency `@seance/irc-protocol: workspace:*`, devDependencies `vitest` `5.1.0` and `fast-check` `4.10.2` (the versions pinned in `apps/ircd`), no other dependency
    - Scripts: `build` (`tsc -p tsconfig.build.json`), `typecheck` (`tsc -p tsconfig.json --noEmit`), `test` (`vitest run`), `lint` (a script that exits non-zero on errors; at minimum `tsc -p tsconfig.json --noEmit` with `noUnusedLocals` already enforced by the base config)
    - `tsconfig.json` extends `../../tsconfig.base.json` and includes `src` and `test` without loosening any option; `tsconfig.build.json` emits `src` only to `dist`; `vitest.config.ts` includes `test/**/*.test.ts`
    - Confirm `turbo.json` already runs `build`, `typecheck`, `test` and `lint` for the new scripts; change it only if a task is missing
    - Run `pnpm install` to update the lockfile
    - _Requirements: 12.7, 12.13, 2.14_

  - [x] 1.2 Add ports, clock and logger
    - `src/ports.ts`: `IrcHost`, `HostClient`, `HostVirtualClient`, `HostChannel`, `HostEvents`, `HostMembership`, `Unsubscribe` exactly as in the design (structural ports, no import from `@seance/ircd`)
    - `src/clock.ts`: `Clock`, `realClock` (unrefs timers), `TimerHandle`, `TimerSet` with `set`, `clear`, `clearAll`, `size`
    - `src/log.ts`: `RunnerLogger` (`debug`, `info`, `warn`, `error`) and `redactFields`
    - `src/index.ts`: export the public API surface created so far
    - _Requirements: 11.7, 12.9, 2.10_

  - [x] 1.3 Implement `loadRunnerConfig(env)` and `ConfigError`
    - Pure function; validates `SEANCE_HARNESS` (unset, empty, `acp`, `headless`), `SEANCE_KIRO_BIN`, `SEANCE_TARGET_REPO`, `SEANCE_WORKSPACES`, `SEANCE_AGENTS_DIR`, `SEANCE_PROMPT_TIMEOUT_MS` (positive integer, default 120000), `SEANCE_CHANNEL_CREDIT_CAP` (finite number > 0), `SEANCE_INVITE_RATE` (positive integer, default 5) and `SEANCE_INVITERS` (comma list, each entry `isValidNick` after trimming; empty after trimming means unset)
    - `ConfigError` names the variable and the rejected value (and both accepted values for `SEANCE_HARNESS`); it never contains the value of `KIRO_API_KEY`
    - Treat an unset or empty `KIRO_API_KEY` as "no key"; the key is carried in the config only to be placed in a child environment
    - Check that `SEANCE_TARGET_REPO` is a git repository and create `SEANCE_WORKSPACES` in the async `validateRunnerPaths(config)` step used by `runner.start()`; fail with an error naming the variable and create no Worktree
    - _Requirements: 2.6, 2.7, 2.8, 2.9, 3.18, 3.19, 3.20, 4.7, 9.17, 10.13_

  - [x] 1.4 Write unit tests for config
    - Every variable valid, unset, empty and invalid; `SEANCE_INVITERS` trimming and invalid entry; error text names variable and value; the `KIRO_API_KEY` value never appears in an error
    - _Requirements: 2.7, 3.19, 3.20, 4.7, 9.17, 10.13_

- [x] 2. Agent registry
  - [x] 2.1 Implement `parseProfile` and `AgentRegistry.load`
    - `src/registry/agent-profile.ts`: `AgentProfile` and `parseProfile(json, file)` with the field rules (nick 1–30 and `isValidNick`, `kiroAgent` 1–64, model 1–64, tools 1–256, color integer 0–15)
    - `src/registry/agent-registry.ts`: read `dir/*.json` at top level only in ascending filename order, never `.kiro/agents`; log one error per rejected file naming file and field and continue; reject a second profile whose `irc_lower(nick)` equals an earlier one with an error naming both files; `lookup(nick)` with `irc_lower`; `NoAgentProfileError` when no profile is valid
    - Loading completes before `load` resolves, so the Runner can start accepting invites only afterwards
    - _Requirements: 1.1, 1.2, 1.4, 1.5, 1.6, 1.7, 1.8_

  - [x] 2.2 Add the three committed profiles
    - `agents/coder.json`, `agents/reviewer.json`, `agents/researcher.json` at the repository root in the format of the design (`nick`, `kiroAgent`, `model`, `tools`, `color`)
    - Make sure the Kiro agent definitions named by `kiroAgent` exist under `agents/.kiro/agents/` so the process cwd = `agents/` resolves them (per the Task 0 finding)
    - _Requirements: 1.3, 1.10_

  - [x] 2.4 Implement the startup agent-file check (fail closed, S8)
    - `src/registry/verify-agent-files.ts`: `verifyAgentFiles(registry, agentsDir)` `stat`s `<agentsDir>/.kiro/agents/<kiroAgent>.json` for every profile (must be a regular file) and throws `AgentFileMissingError(profileFile, kiroAgent, expectedPath)` for the first missing one; no process is spawned and no invite accepted before it passes (called from `runner.start()`, task 19.1)
    - _Requirements: 1.11_

  - [x] 2.5 Write unit tests for the startup agent-file check
    - The committed `agents/` passes; a profile whose `.kiro/agents/<kiroAgent>.json` is missing (temporary directory) fails with an error naming profile file, agent name and expected path; a directory instead of a file fails
    - _Requirements: 1.11_

  - [x] 2.3 Write unit tests for the registry
    - Loads exactly `coder`, `reviewer`, `researcher` from the committed `agents/`; case-mapped lookup; invalid JSON, missing field, wrong type, color 16, invalid nick each skipped with a named error; duplicate nick keeps the first; no valid profile throws `NoAgentProfileError`; `.kiro/agents` is never read
    - _Requirements: 1.3, 1.4, 1.5, 1.6, 1.7, 1.8_

- [x] 3. ACP frames and client (promoted from `spikes/acp/src/acp-client.ts`)
  - [x] 3.1 Promote `redact()` and add value redaction
    - `src/acp/redact.ts`: the spike's `redact(line)` plus `redactJson` for secret-looking keys (`token`, `secret`, `password`, `authorization`, `api_key`, `apiKey`, `credential`, any letter case, any depth) and `redactValues(text, secrets)` for the `KIRO_API_KEY` value
    - Idempotent: `redact(redact(x)) == redact(x)`
    - _Requirements: 2.10_

  - [x] 3.2 Implement `parseFrame(line)` and encode helpers
    - `src/acp/frames.ts`: `Frame` union (request, notification, response, error-response) and `{kind: "invalid", reason}`; never throws; id is a number or string; unknown `_kiro.dev/*` notifications are valid notification frames
    - _Requirements: 2.11, 2.12_

  - [x] 3.3 Write property test P11 (frame boundary totality and id preservation)
    - **Property 11: parseFrame is total and request ids are echoed unchanged**
    - Tag `Feature: agent-runner, Property 11: parseFrame is total and request ids are echoed unchanged`, `numRuns` ≥ 100, in `test/acp-frames.property.test.ts`
    - **Validates: Requirements 2.11, 2.12, 8.9**

  - [x] 3.4 Write property test P12 (log redaction)
    - **Property 12: redaction removes secret values and is idempotent**
    - Tag `Feature: agent-runner, Property 12: redaction removes secret values and is idempotent`, `numRuns` ≥ 100, in `test/acp-frames.property.test.ts` or `test/redact.property.test.ts`; cover secret keys at any depth and the `KIRO_API_KEY` value embedded in command lines and error messages
    - **Validates: Requirements 2.10**

  - [x] 3.5 Implement `AcpClient`
    - `src/acp/client.ts`: promote the spike client with injected `{command, args, cwd, env, logger, clock}`; frames and command lines logged through redaction; numeric request ids, responses matched by `String(id)`; invalid frame discarded with one error log and the process and sessions stay open; last stderr line captured; `onActivity`; `kill(signal)` and `exited`; `close()` ends stdin, `SIGTERM`, `SIGKILL` after 5 s
    - Spawn failure or exit before the `initialize` response rejects every pending request with `<command> failed: <exit code or signal>, last stderr: <line>`, and the next request spawns a new process
    - `handle("session/request_permission", fn)` answers with the request id unchanged; a handler exception answers with a cancelled outcome
    - No new runtime dependency
    - _Requirements: 2.10, 2.11, 2.12, 2.13, 2.14, 8.9_

  - [x] 3.6 Write unit tests for `AcpClient` against the Fake_Agent
    - Spawn failure, early exit with last stderr line, string and numeric id echo, invalid frame keeps the process open, unknown `_kiro.dev/*` ignored without an error log, respawn on the next request
    - _Requirements: 2.11, 2.12, 2.13, 8.9_

- [x] 4. Fake_Agent and test fixtures (built early; every later test uses them)
  - [x] 4.1 Implement the Fake_Agent
    - `test/fixtures/fake-agent.ts`: `FakeAgentCore` (pure state machine with a virtual clock: `handleLine(line)` and `advance(ms)` return outgoing lines) plus the stdio wrapper in the same file; answers `initialize`, `session/new`, `session/prompt`, `session/cancel` in the `kiro-cli acp` shape with `stopReason` `end_turn` or `cancelled`; `session/new` returns `modes: {currentModeId, availableModes}` with `currentModeId` = the agent name given to the launcher (`FAKE_AGENT_NAME`)
    - Script via `FAKE_AGENT_SCRIPT` (inline JSON or path): steps `chunk`, `thought`, `toolCall`, `permission` (string ids by default), `metadata`, `delay` (0–600000 on the virtual clock), `gate`, `crash` (non-zero exit), `stop`; `match`, `settleMs`, `initExitCode`, `metadataAfterCancel`, `modeId` (overrides `currentModeId` in the `session/new` response, e.g. `"kiro_default"`, to simulate the S8 silent fallback)
    - Cancel-then-reuse race: a prompt arriving before `settleUntil` (or before the scripted metadata) resolves immediately as `cancelled`; a cancel with no turn in flight poisons the next prompt
    - Non-JSON-RPC lines answered with a JSON-RPC error without exiting; `fake/advance`, `fake/release`, `fake/dump` introspection
    - Add an executable launcher `test/fixtures/fake-kiro` that ignores `acp --agent <name>` arguments and runs the Fake_Agent, so `SEANCE_KIRO_BIN` can point at it
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6_

  - [x] 4.2 Add shared fixtures
    - `test/fixtures/manual-clock.ts` (`Clock` with `advance(ms)`), `test/fixtures/temp-repo.ts` (git init and commit in `os.tmpdir()`, disposer that always runs, also on failure), `test/fixtures/arbitraries.ts` (multi-byte text, valid nicks, channel names, tag-heavy text, entries for metering)
    - _Requirements: 12.9, 12.10_

  - [x] 4.3 Write unit tests for the Fake_Agent
    - Response shapes; `end_turn` vs `cancelled`; the cancel-then-reuse race resolves the early prompt as `cancelled`; a stray cancel poisons the next prompt; non-JSON-RPC line yields an error response and the process keeps running; virtual-time delays fire only on `advance`; `session/new` reports `currentModeId` equal to the launcher's agent name by default and the scripted `modeId` (`kiro_default`) when set
    - _Requirements: 12.2, 12.3, 12.4, 12.5, 12.14_

- [x] 5. Harness (`AgentHarness`, `AcpHarness`, `HeadlessHarness`)
  - [x] 5.1 Define the `AgentHarness` interface and `buildSpawnSpec`
    - `src/harness/harness.ts`: `AgentHarness`, `HarnessSession`, `SessionEvent`, `ToolInfo`, `PermissionRequest`, `PermissionAnswer`, `PermissionHandler`, `ProcessEvent`, `TurnResult`, `StopReason`
    - `src/harness/spawn.ts`: `buildSpawnSpec(profile, config)` returning `command = kiroBin`, `args = ["acp", "--agent", kiroAgent]`, `cwd = agentsDir` (the session worktree is passed only to `session/new`), `env` with `KIRO_API_KEY` only when set and non-empty and never in `args`; `--trust-all-tools` is built nowhere
    - _Requirements: 2.1, 2.4, 2.8, 2.9, 1.10_

  - [x] 5.2 Implement `AcpHarness`
    - `src/harness/acp-harness.ts`: one `AcpClient` per Agent created on the first `openSession` (concurrent first calls share one spawn promise) and recreated after exit; `initialize` advertises no `fs` capability; `session/new` with `{cwd, mcpServers: []}` per channel in the existing process
    - Fail closed on agent resolution: after every `session/new` compare `modes.currentModeId` with `profile.kiroAgent`; on a mismatch or absent mode close the session locally, `terminate(profile, "SIGTERM")`, throw `AgentProfileNotLoadedError(kiroAgent, actualModeId)` and never return a `HarnessSession`, so no `session/prompt` can be sent
    - Route `session/update` by `sessionId` to `message-chunk`, `thought-chunk`, `tool-call`, `unknown`; map `_kiro.dev/metadata` to `metadata`; drop notifications for unknown session ids with one debug line
    - Route `session/request_permission` to the session's `onPermission`, extracting `ToolInfo` (`kind`, `title`, `rawInput.path`, `rawInput.command`, `locations[].path`) and answering with the option whose `kind` equals the decision, or a cancelled outcome when the option is missing or the request is malformed (cause logged without secrets)
    - Emit `{kind: "exited"}` process events; `terminate`, `hasProcess`, `dispose`
    - _Requirements: 2.2, 2.3, 2.13, 7.11, 8.9, 8.10_

  - [x] 5.3 Add the hung-agent watchdog to `AcpHarness`
    - Timer from the injected `Clock`, armed when the first Turn of the process starts and re-armed on every frame; disarmed when no Turn is in flight; default `SEANCE_PROMPT_TIMEOUT_MS`
    - On expiry emit `{kind: "hung", agent, sessionIds}`, reject every pending `prompt`, and send `SIGTERM`
    - _Requirements: 9.12, 9.13_

  - [x] 5.4 Implement `HeadlessHarness`
    - `src/harness/headless-harness.ts`: `kiro-cli chat --agent <kiroAgent> --no-interactive <prompt>` once per prompt with cwd = the session cwd and `KIRO_API_KEY` only in the environment; stdout lines become `message-chunk` events; `cancel` sends `SIGTERM` to the current child; `terminate` is a no-op; no credits reported
    - Document the limitation (no permission requests, write-capable headless operation out of scope) in a code comment
    - _Requirements: 2.5, 2.8, 2.9_

  - [x] 5.5 Add the in-process `FakeHarness` fixture
    - `test/fixtures/fake-harness.ts`: `AgentHarness` on top of `FakeAgentCore` with no child process, used by the reducer-with-effects, exorcism, credit and output tests; records `session/prompt` and `session/cancel` calls
    - _Requirements: 12.6_

  - [x] 5.6 Write unit tests for the harnesses
    - Exactly one process per Agent and one ACP session per channel (two channels, one spawn); `--trust-all-tools` absent from every spawn spec; `KIRO_API_KEY` only in `env`, never in `args`, absent when unset or empty; `SIGTERM` and respawn; headless command line; watchdog fires after the timeout with fake timers and re-arms on frames
    - Wrong mode (Fake_Agent script `modeId: "kiro_default"`): `openSession` rejects with `AgentProfileNotLoadedError`, the Fake_Agent process receives `SIGTERM` and exits, its `fake/dump` (or the harness-side recorder) shows zero `session/prompt` requests, and a following `openSession` spawns a fresh process; a matching mode succeeds
    - _Requirements: 2.2, 2.3, 2.4, 2.5, 2.8, 2.9, 2.15, 2.16, 9.12, 9.13, 12.14_

- [x] 6. Checkpoint - harness and fixtures
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Worktrees
  - [x] 7.1 Implement `sanitizeChannel` and `confine`
    - `src/worktree/sanitize.ts`: the four-step algorithm of the design (`irc_lower`, drop `#` or prefix `_x`, escape every other code point as `_` plus lower-case hex per UTF-8 byte, `_00` for empty, 38 chars + `__` + 24 hex digits of `sha256` for results over 64)
    - `src/worktree/confine.ts`: `resolveInside(root, path)` with `realpath` and a strictly-inside check; equal or outside throws `WorktreeConfinementError` naming the channel
    - _Requirements: 4.2, 4.3, 4.4, 4.5, 4.11_

  - [x] 7.2 Write property test P7 (worktree path confinement)
    - **Property 7: the worktree path of any channel name is strictly inside the worktree root**
    - Tag `Feature: agent-runner, Property 7: the worktree path of any channel name is strictly inside the worktree root`; clauses (a)–(c) with `numRuns` ≥ 100 and no I/O, clause (d) with `numRuns` ≥ 100 against real temporary directories (root reached through a symlink) removed in `finally`
    - **Validates: Requirements 4.11, 4.2, 4.3, 4.4**

  - [x] 7.3 Implement git runner and `WorktreeManager`
    - `src/worktree/git.ts`: `runGit(args[])` with `execFile` (no shell) and a per-repo mutex
    - `src/worktree/worktree-manager.ts`: `ensure(channel)` (reuse when `rev-parse --show-toplevel` matches, otherwise `git worktree add -b seance/<sanitized> -- path HEAD` or add the existing branch; `confine` before returning), `reset(channel)` (verify confinement and that the toplevel is the worktree itself, then `reset --hard HEAD` and `clean -fd`; keeps branch and log), `privateDir(agentNick)`
    - Failures throw `WorktreeError(channel, operation, stderr)` and change nothing else
    - Config exclusion (S9): after `worktree add` enable `extensions.worktreeConfig` and run `sparse-checkout set --no-cone '/*' '!AGENTS.md' '!agents.md' '!.kiro/' '!**/AGENTS.md' '!**/agents.md' '!**/.kiro/'`
    - `src/worktree/scan-config.ts`: `scanConfig(path)` walks the whole worktree (`readdir` with file types, never follows symlinks, skips only the root `.git`, does not descend into a found `.kiro`) and returns the relative paths of every entry whose lower-cased name is `agents.md` or `.kiro` (file, directory or symlink)
    - `ensure` runs `scanConfig` after creation and on every reuse and throws `WorktreeError(channel, "config-exclusion", paths)` on a hit, so no session starts
    - `guardBeforePrompt(channel)`: `confine`, `scanConfig`; on a hit `reset(channel)`, remove exactly the found entries (confined by `realpath`), re-scan, return `{ok: false, paths}` (throw `WorktreeError` if still present); never cancels anything
    - _Requirements: 4.1, 4.6, 4.8, 4.9, 4.10, 4.12, 4.13, 4.14, 5.10_

  - [x] 7.4 Write unit tests for worktrees against a temporary repository
    - Create, reuse (no second branch or worktree), reset discards uncommitted and untracked files and keeps the branch, failed `git worktree add` and failed reset leave contents unchanged and name the channel and operation, symlink escape refused, channel names with `/`, `..`, NUL and spaces never reach a shell; every repository removed in `finally`
    - A target repository committing `AGENTS.md`, `agents.md`, `.kiro/skills/x/SKILL.md`, `docs/deep/AGENTS.md` and `packages/x/.kiro/steering/a.md` yields a worktree without any of them (sparse-checkout at every depth)
    - `scanConfig` finds entries at depth 0 and at depth 3, in any letter case (`Agents.MD`, `.KIRO`), ignores lookalikes (`AGENTS.md.bak`, `.kiroish`, any entry named `AGENTS.md` is reported whether it is a file, a directory or a symlink), does not follow a symlink to a directory holding `AGENTS.md`, and skips the root `.git`
    - Planting any of them into an existing worktree makes `ensure` refuse with `config-exclusion` naming the relative paths
    - _Requirements: 4.1, 4.5, 4.6, 4.8, 4.9, 4.10, 4.12, 4.13, 12.10_

- [x] 8. Session reducer (pure)
  - [x] 8.1 Implement `transition()` and the session types
    - `src/session/machine.ts`: `SessionState`, `SessionModel`, `MachineEvent`, `Effect`, `Prompt` and `transition(model, event)` implementing the transition table of the design (queue bound 20 with oldest-dropped overflow, cancel only from `prompting`, cooldown, `begin-closing`, `close`, closed rejects every prompt)
    - A new Session after `closed` starts from a fresh model
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11, 6.12, 6.13_

  - [x] 8.2 Write property test P1 (state-machine safety)
    - **Property 1: at most one in-flight prompt, cancel only while prompting, no prompt during cancelling or cooldown**
    - Tag `Feature: agent-runner, Property 1: at most one in-flight prompt, cancel only while prompting, no prompt during cancelling or cooldown`, `numRuns` ≥ 100, in `test/session-machine.property.test.ts`; include impossible events on purpose
    - **Validates: Requirements 6.14, 6.3, 6.6, 6.7**

  - [x] 8.3 Write property test P2 (exactly-once, in-order delivery)
    - **Property 2: every enqueued prompt is sent or reported dropped exactly once, in enqueue order**
    - Tag `Feature: agent-runner, Property 2: every enqueued prompt is sent or reported dropped exactly once, in enqueue order`, `numRuns` ≥ 100, bursts of up to 60 enqueues to force overflow
    - **Validates: Requirements 6.15, 6.10, 6.11, 6.12, 6.4, 6.9**

  - [x] 8.4 Write unit tests for the transition table
    - One test per row and column of the table in `test/session-machine.test.ts`: idle send, queued while busy, `end_turn` drain, failure with notice, cancel exactly once, cancel ignored outside `prompting`, cooldown elapsed, overflow notice, close drops queue, closed rejects, unrequested `cancelled` goes to cooldown
    - _Requirements: 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11, 6.12, 6.13_

- [x] 9. Session runtime and store
  - [x] 9.1 Implement `WhoisSnapshot`
    - `src/whois/snapshot.ts`: per-Agent `model`, `tools`, `away?`, per-channel `{name, state, credits}` and `total`; synchronous setters `setState`, `setCredits`, `setAway`
    - _Requirements: 10.17_

  - [x] 9.2 Implement `SessionStore` and the in-memory store
    - `src/session/session-store.ts` (`SessionRecord`, `SessionStore` with `get`, `put`, `list`) and `src/session/memory-session-store.ts` (`Map` keyed `agent\0channel`)
    - _Requirements: 10.3_

  - [x] 9.3 Implement `Session` (effects runner)
    - `src/session/session.ts`: runs reducer effects against a `HarnessSession` and the `Clock`/`TimerSet`: `send-prompt` calls `prompt` and posts `turn-ended` (rejection becomes `{error}`; other stop reasons map to `other`), `send-cancel` calls `cancel` once, `start-cooldown` sets a 1000 ms timer and a `metadata` event with `turnDurationMs` in `cooldown` also posts `cooldown-elapsed` (first wins, timer cleared), `drop` goes to a `PromptSink`, `notify-ops` goes to an `opNotice` sink
    - Every state change calls `snapshot.setState` synchronously; a blocked channel (credit-blocked check) turns `enqueue` into `drop(credit-blocked)` before the reducer
    - Expose `sessionEvents` and a `turnEnding` hook so output streaming can attach (task 11.3) without Session knowing about IRC
    - `PromptGate` port (`check(): Promise<{ok: true} | {ok: false, paths}>`, wired to `WorktreeManager.guardBeforePrompt` in the composition root): `send-prompt` calls it before `harness.prompt`; a refused check sends no `session/prompt`, reports the prompt dropped (`config-present`), posts `turn-ended {error: "config-present"}` and sends one `opNotice` naming the agent and the relative paths (≤ 512 bytes); never calls `cancel`, never touches a turn in flight
    - _Requirements: 4.14, 6.2, 6.3, 6.4, 6.5, 6.6, 6.8, 6.9, 6.10, 6.11, 6.12, 10.10, 10.17_

  - [x] 9.4 Write unit tests for `Session` with `FakeHarness` and `ManualClock`
    - Cooldown by 1000 ms and by the `turnDurationMs` shortcut, cancel-then-reuse race never sends a prompt during cooldown, failure notice, queue overflow notice, closed rejects, snapshot updated before the next event, and a P1 variant that checks `session/prompt` and `session/cancel` counts from the harness side
    - _Requirements: 6.5, 6.6, 6.8, 6.9, 6.10, 6.14, 10.17_

  - [x] 9.5 Write `prompt-gate.test.ts` (required security test) with a real temporary repository, `FakeHarness` and `ManualClock`
    - `AGENTS.md` (also `docs/Agents.md`) or `.kiro/skills/x/SKILL.md` appears in the worktree after `ensure` and before the next prompt: no `session/prompt` is recorded for that prompt, it is reported dropped, the entries are gone afterwards, the worktree is reset (an unrelated untracked file is gone, the branch is kept), the ops get exactly one `NOTICE` naming the agent and the relative paths within 512 bytes, and `session/cancel` count stays 0
    - The entries appear while a turn is in flight: that turn finishes normally (no cancel, no interruption), and the next queued prompt is the one refused; a following clean prompt is sent normally
    - Two queued prompts with the entry present: only the first is refused and dropped, the second is checked on its own and sent after the clean-up
    - If removal fails (entry kept), `WorktreeError(channel, "config-exclusion", ...)` surfaces and still no `session/prompt` is sent
    - _Requirements: 4.14, 6.5_

- [x] 10. Prompt builder and channel log
  - [x] 10.1 Implement untrusted wrapping and prompt builders
    - `src/prompt/untrusted.ts`: `neutralise` (every opening or closing `untrusted` tag form, case-insensitive, optional whitespace, replaced by a marker without `<`) and `wrapUntrusted`
    - `src/prompt/builder.ts`: `buildChannelPrompt` (`[#ch] <nick> text`, `@` before the nick for `+o`; Human_Op text outside a wrapper, all other text inside), `buildPrivatePrompt`, `buildResumePrompt` (template header, topic or `(no topic set)` inside a wrapper, last 50 log lines inside a wrapper); each returns text plus segments
    - _Requirements: 5.2, 5.3, 5.4, 5.5, 5.6, 5.11, 3.7, 3.8_

  - [x] 10.2 Implement `ChannelLog`
    - `src/prompt/channel-log.ts`: ring buffer of the last 50 `{nick, text, ts}` per `irc_lower(channel)`, 512 bytes of text per line, oldest evicted first
    - _Requirements: 3.7_

  - [x] 10.3 Write property test P3 (untrusted wrapping)
    - **Property 3: text outside untrusted wrappers is only template and Human_Op text, one closing tag per wrapper**
    - Tag `Feature: agent-runner, Property 3: text outside untrusted wrappers is only template and Human_Op text, one closing tag per wrapper`, `numRuns` ≥ 100, tag-heavy text, oracle built from generator input; covers channel, private and resume prompts
    - **Validates: Requirements 5.13, 5.2, 5.3, 5.4, 5.5, 5.6, 5.11, 3.8**

  - [x] 10.4 Write unit tests for prompts and the log
    - Format examples from the design, `@` prefix, voiced human and other agent wrapped, topic wrapped with empty-topic marker, resume summary of 50 vs fewer lines, log eviction and 512-byte cap
    - _Requirements: 5.2, 5.3, 5.4, 5.5, 3.7, 3.8_

- [x] 11. Output streaming
  - [x] 11.1 Implement `formatLines`, `budgetFor` and `SentenceBuffer`
    - `src/output/line-format.ts`: strip CR, LF, NUL; drop whitespace-only text; cut at code point boundaries so each serialized line (prefix, target, `\x03NN`, text, `\x0F`, CRLF) is at most 512 bytes; lone surrogates counted as 3 bytes; `budgetFor(prefix, target)`
    - `src/output/sentence-buffer.ts`: append in arrival order, emit complete sentences (terminator followed by whitespace, or newline), keep the incomplete tail, Idle_Flush after 1500 ms with an injected `Clock`, `flush()` at end of Turn, `dispose()`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_

  - [x] 11.2 Implement `AgentOutput`
    - `src/output/agent-output.ts`: `say(text)` dispatches one `PRIVMSG` per line through the virtual client (agent text only in the trailing parameter, never parsed or routed as a command, a leading `/` is plain text; a `dispatch` exception is logged and the line dropped); `toolStarted(summary)` sets `AWAY` (clamped to 200 bytes at a code point boundary, mirrored in the snapshot) and sends one channel `NOTICE` truncated to the line budget; `clearAway()`; `channelNotice` and `opNotice` helpers
    - Thought chunks and unknown `sessionUpdate` values send nothing to IRC
    - _Requirements: 7.8, 7.9, 7.10, 7.11, 7.12_

  - [x] 11.3 Wire output into `Session`
    - Connect `message-chunk` to `SentenceBuffer.append`, `tool-call` to `toolStarted`, ignore `thought-chunk` and `unknown`; flush the buffer and clear `AWAY` before the Turn is reported as ended
    - _Requirements: 7.1, 7.4, 7.9, 7.10, 7.11, 7.12_

  - [x] 11.4 Write property test P5 (output line bound)
    - **Property 5: every emitted line is at most 512 bytes with no CR, LF or NUL and no character is lost**
    - Tag `Feature: agent-runner, Property 5: every emitted line is at most 512 bytes with no CR, LF or NUL and no character is lost`, `numRuns` ≥ 100, arbitrary chunk boundaries, 4-byte emoji runs, colors 0–15, nick up to 30 bytes, host up to 63 bytes, multi-byte channel names; lines serialized with the real prefix
    - **Validates: Requirements 7.13, 7.5, 7.6, 7.7, 7.2**

  - [x] 11.5 Write unit tests for output
    - Sentence splitting (`3.14` and `v1.2.3` not split), Idle_Flush at 1500 ms with fake timers, flush at end of Turn, `AWAY` set on tool call and cleared at Turn end, `AWAYLEN` truncation, thoughts and unknown updates ignored, `/kick x` text sent as plain `PRIVMSG`, `dispatch` failure does not crash the session
    - _Requirements: 7.2, 7.3, 7.4, 7.8, 7.9, 7.10, 7.11, 7.12_

- [x] 12. Permissions
  - [x] 12.1 Implement `decide` and the deny list
    - `src/permissions/policy.ts`: pure `decide(input)` with the rule order of the design (unclassified, unresolved or empty path, outside worktree, deny list, no mode, read, write/shell only for `op`); kind classification table
    - `src/permissions/deny-list.ts`: pure `matchDenyList(command, worktree)` (`rm -rf` outside the worktree, `git push --force` and variants, network package installs, `curl|wget` piped into a shell) and pure `referencesProtectedPath(command)` (tokenise on whitespace, separators, redirections, quotes, parentheses, backticks and `=`, split on `/` and `\`; reject a segment equal to `agents.md` or `.kiro` in any letter case, or a glob segment that can match either); `matchDenyList` applies it first
    - `isProtectedPath(resolved)` in `policy.ts` and the `protected-path` reason: in `decide`, a `write` call (edit, delete, move; every path, so source and destination of a rename) with a protected raw or resolved path is rejected for every mode including `op`, after the confinement rule and before the mode rules
    - _Requirements: 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.13, 8.14, 8.15_

  - [x] 12.2 Implement `canonicalise` and `handlePermissionRequest`
    - `src/permissions/canonicalise.ts`: join relative paths to the worktree, `realpath` the deepest existing ancestor and append the rest; failure yields `resolved: undefined`
    - `src/permissions/handler.ts`: read the Agent's current mode now through `host.modeOf` (never cached from session creation); Private_Session uses `voice` with the private directory and turns any write or shell into `reject_once`; one channel `NOTICE` `ops: <agent> denied <tool>: <reason>` within the same tick and at most 512 bytes including CRLF for any reason except `no-mode`; select the first option whose `kind` equals the decision, never `allow_always`; cancelled outcome and a log line without secrets for a malformed request or missing option
    - A `protected-path` rejection sends the same ops `NOTICE` (`ops: <agent> denied <tool>: protected-path`) naming the path, clamped to 512 bytes
    - `fs/*` is not implemented as an enforcement point
    - _Requirements: 8.1, 8.5, 8.8, 8.9, 8.10, 8.11, 8.12, 8.16_

  - [x] 12.3 Write property test P4 (permission purity, worktree confinement and protected paths) — required security test
    - **Property 4: decide never allows outside the worktree, never allows write or shell without +o, and never allows a write to or a shell reference of AGENTS.md / .kiro**
    - Tag `Feature: agent-runner, Property 4: decide never allows outside the worktree, never allows write or shell without +o, and never allows a write to or a shell reference of AGENTS.md / .kiro`, `numRuns` ≥ 100, includes the sibling-prefix case (`/w/ch` vs `/w/ch-evil`), deep-frozen input, and equal results on a second call
    - Clauses (e1) and (e2) of the design: protected write paths (`AGENTS.md`, `agents.md`, `Agents.MD`, `.kiro`, `.KIRO` at depth 0–4, rename and move with a protected source or destination) and protected shell references (`cat AGENTS.md`, `echo x > docs/agents.md`, `rm -r .kiro`, `FOO=.kiro ls`, `ls .ki*`, quoted names) are rejected in every mode including `op`; lookalikes (`AGENTS.md.bak`, `MY-AGENTS.md`, `.kiroish`, `kiro`) are not rejected by this rule
    - **Validates: Requirements 8.13, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.14, 8.15**

  - [x] 12.4 Write unit tests for permissions — required security test
    - Kind table, deny-list examples, `canonicalise` against a temporary directory with a symlink pointing outside the worktree, handler answers with string and numeric ids, mode read at request time (a `/mode +o` between two requests changes the second answer), private session rejects writes, notice text under 512 bytes, missing option and malformed request answered cancelled
    - Protected paths: a `+o` agent's `edit`, `delete` and `move` on `AGENTS.md`, `sub/agents.md`, `.kiro/hooks/x.json` and `a/b/.KIRO/y` get `reject_once`; a symlink with an innocent name pointing into a `.kiro` directory is rejected after `canonicalise`; a shell call `cat AGENTS.md`, `rm -rf .kiro` or `echo x >> docs/AGENTS.md` is rejected for `+o`; an ordinary file in the same worktree is still allowed for `+o`; each rejection sends one ops `NOTICE` with reason `protected-path`
    - _Requirements: 8.1, 8.5, 8.7, 8.8, 8.9, 8.10, 8.11, 8.12, 8.14, 8.15, 8.16_

- [x] 13. Credits and WHOIS
  - [x] 13.1 Implement `acceptMetering` and `CreditAccumulator`
    - `src/credits/accumulator.ts`: accept an entry only when `unit === "credit"` and `value` is a finite number ≥ 0; sum accepted values in order; report each rejected entry with a reason (`unit`, `negative`, `not-finite`); one log line per rejected entry naming session, unit and reason
    - _Requirements: 10.1, 10.2_

  - [x] 13.2 Write property test P6 (credit accumulation)
    - **Property 6: session credits never decrease and equal the sum of accepted metering values**
    - Tag `Feature: agent-runner, Property 6: session credits never decrease and equal the sum of accepted metering values`, `numRuns` ≥ 100, dyadic values so addition is exact, entries with `NaN`, `Infinity`, negatives, strings, `null`
    - **Validates: Requirements 10.15, 10.1, 10.2**

  - [x] 13.3 Implement `CreditLedger`
    - `src/credits/ledger.ts`: keyed by (agent, channel), survives Session replacement; `add` updates the per-channel sum, the per-agent total and the snapshot synchronously; schedules one `SessionStore.put` through a 250 ms coalescing timer (retry on the next change after a failure, logged); cap from `SEANCE_CHANNEL_CREDIT_CAP`: when the channel sum exceeds it, cancel every `prompting` Session of the channel, send one `opNotice` naming channel, total and cap to each Human_Op, and mark the channel credit-blocked; `isBlocked(channel)`, `clearBlocked`
    - Hook the accumulator into the Session `metadata` handler so credits are added before the next metadata message is processed
    - _Requirements: 10.1, 10.3, 10.9, 10.10, 10.17_

  - [x] 13.4 Implement `!reset-credits`
    - `src/credits/reset-command.ts`: handled only in a private message to the Agent and only for the exact trimmed text; clear the mark in each of the Agent's blocked channels where the sender has `+o` and send a `NOTICE` naming them; sender without `+o` anywhere: marks stay and `NOTICE` says operator rights are required; no blocked channel: discard and `NOTICE` that no channel is credit-blocked; never forwarded to the Agent as a prompt
    - _Requirements: 10.11, 10.12, 10.14, 10.16_

  - [x] 13.5 Implement `renderWhois`
    - `src/whois/render.ts`: pure `renderWhois(entry | undefined): readonly string[]` with `model:`, `tools:`, `status:` (priority `prompting` > `cooldown` > `away` > `idle`) and one `credits: <channel> <n.nn> / total <n.nn>` line per non-closed channel ordered by `irc_lower(channel)`, `toFixed(2)`; missing entry gives `[]`, a partial entry gives only derivable lines; never throws
    - `whoisExtra` closure: synchronous, reads only the snapshot, no `await`, no store call
    - _Requirements: 10.4, 10.5, 10.6, 10.7, 10.8, 10.18, 10.19, 10.20, 3.11_

  - [x] 13.6 Write property test P8 (whois snapshot purity)
    - **Property 8: renderWhois is total, deterministic, derived only from the snapshot and formats two decimals**
    - Tag `Feature: agent-runner, Property 8: renderWhois is total, deterministic, derived only from the snapshot and formats two decimals`, `numRuns` ≥ 100, `SessionStore` spy that throws on any call, `whoisExtra` result is not a thenable
    - **Validates: Requirements 10.4, 10.5, 10.6, 10.7, 10.8, 10.18, 10.19, 10.20**

  - [x] 13.7 Write unit tests for credits
    - Persistence to the store within 1000 ms with the `ManualClock`, store failure logged and retried, cap exceeded cancels in-flight prompts and sends one notice per Human_Op, blocked channel drops prompts, ledger survives Session replacement, each `!reset-credits` branch, `!reset-credits` never reaches the harness
    - _Requirements: 10.3, 10.9, 10.10, 10.11, 10.12, 10.14, 10.16_

- [x] 14. Checkpoint - core components
  - Ensure all tests pass, ask the user if questions arise.

- [x] 15. SessionManager and message routing
  - [x] 15.1 Implement `SessionManager`
    - `src/session/session-manager.ts`: sessions by Invite_Key; `onChannelMessage` for `PRIVMSG` only: for every Agent Session in the channel except the sender, read `modeOf` now, skip Agents with no mode and, under `+m`, Agents with neither `+v` nor `+o`, build the prompt with `buildChannelPrompt` and enqueue exactly one prompt each; fill `ChannelLog` from every channel message
    - Private messages arrive on the Agent's own virtual client listener: intercept `!reset-credits` first, otherwise enqueue into a Private_Session for (agent, human) opened with `cwd` = `privateDir(agent)`, no write or shell permission, Human_Op text unwrapped and other senders wrapped
    - A `NOTICE`, or a target that is neither a channel with a Session nor a known Agent nick, enqueues nothing and logs the ignored event and the reason
    - Prompts reach an Agent only through its Session, never as an IRC command
    - _Requirements: 5.1, 5.7, 5.8, 5.9, 5.10, 5.11, 5.12, 5.14, 10.14_

  - [x] 15.2 Write unit tests for routing
    - Prompt per `+v`/`+o` Agent except the sender; no prompt with no mode; `+m` with no `v`/`o`; `NOTICE` ignored with a log entry; private message creates a separate Private_Session with the private directory; Human_Op determination for private messages; `!reset-credits` intercepted
    - _Requirements: 5.1, 5.7, 5.8, 5.9, 5.10, 5.11, 5.14_

- [x] 16. Invite handling
  - [x] 16.1 Implement allow-list, ban list and resolver
    - `src/invite/allow-list.ts` (`parseInviters`, `allows` with `irc_lower`), `src/invite/ban-list.ts` (`${irc_lower(channel)}\0${irc_lower(nick)}`), `src/invite/resolver.ts` (`createInviteResolver`: true iff the nick is registered, not banned for the channel and the inviter is permitted; synchronous, no I/O, no state change; evaluated before the rate limit and before any dedup entry)
    - _Requirements: 3.1, 3.14, 3.15, 9.10, 9.11_

  - [x] 16.2 Implement `InviteGate`
    - `src/invite/invite-gate.ts`: `decide(key, inviterKey, ts)`: key present gives `duplicate` (no count); else prune the 60 s window, at `limit` gives `rate-limited` with `retryAfterSec = ceil((oldest + 60000 − ts) / 1000)`; else count, add the key and return `start`; `release(key)`; time comes from the event `ts`
    - _Requirements: 3.10, 3.13, 3.16, 3.17, 3.18_

  - [x] 16.3 Write property test P9 (invite resolver claim rule)
    - **Property 9: the invite resolver claims exactly registered, unbanned, permitted nicks and leaves no state**
    - Tag `Feature: agent-runner, Property 9: the invite resolver claims exactly registered, unbanned, permitted nicks and leaves no state`, `numRuns` ≥ 100, rfc1459 case variants, `structuredClone` state comparison, non-thenable result
    - **Validates: Requirements 3.1, 3.14, 3.15, 9.10, 9.11**

  - [x] 16.4 Write property test P10 (invite dedup and rate limit)
    - **Property 10: at most one start per live invite key and at most N counted invites per inviter per minute**
    - Tag `Feature: agent-runner, Property 10: at most one start per live invite key and at most N counted invites per inviter per minute`, `numRuns` ≥ 100, deltas at 0, 59 999 and 60 000 ms, compared with a reference model
    - **Validates: Requirements 3.10, 3.13, 3.16, 3.17, 3.18**

  - [x] 16.5 Implement `InviteController`
    - `src/invite/invite-controller.ts`: on `irc.invite`: online non-agent nick gives a server `NOTICE` to the inviter and stops; online Agent repeats the ban and allow-list check (D7); `InviteGate.decide`; a duplicate is silent; rate-limited sends one `NOTICE` with the limit and seconds; on `start` create the virtual client if missing (`NICK`, `USER`, wait for `001` within 5 s, `whoisExtra` backed by the snapshot), `JOIN` leaving no mode, `ensure` the Worktree, open the ACP session within 30 s of the join, create the Session and the first prompt as `buildResumePrompt` when a closed Session existed
    - Any pipeline failure: `PART`, a channel `NOTICE` naming the step and cause, `release(key)`, Session recorded `closed`, other Sessions untouched; an `aborted` flag is checked between steps
    - On `AgentProfileNotLoadedError` from `openSession` additionally send the inviter one server-prefixed `NOTICE` `agent profile <kiroAgent> not loaded` through `host.noticeTo`; no prompt is ever sent to that session (on revival, task 17.3, only the channel `NOTICE` applies)
    - _Requirements: 2.16, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11, 3.12, 3.13, 3.16, 3.17_

- [x] 17. Exorcism, hung agents and process exit
  - [x] 17.1 Implement `exorcise`
    - `src/exorcism/exorcism.ts`: strictly ordered: `begin-closing`, (a) `session/cancel` only if `prompting`, (b) wait for the Cooldown, (c) `reset(channel)` for that channel only, (d) close the Session; then `PART :*** <nick> has been exorcised` if the Agent is still a member; a reset failure reports an error naming the channel and cause, still closes and still leaves; channel log and branch untouched; release the Invite_Key and clear `AWAY`; single-flight per Invite_Key
    - _Requirements: 9.4, 9.5, 9.6, 9.7, 9.8, 9.9_

  - [x] 17.2 Wire the Exorcism triggers
    - `src/exorcism/triggers.ts`: `irc.kick` naming an Agent, the Agent's own `PART` on its virtual client listener, and an `ERROR` message (sent by `close()`) as the `QUIT` signal, which exorcises every Session of that Agent
    - _Requirements: 9.1, 9.2, 9.3_

  - [x] 17.3 Handle process exit and revival
    - In `SessionManager`: on `{kind: "exited"}` move all Sessions of that process to `closed`, report queued prompts as dropped and leave the Agents in their channels; a prompt arriving for an Agent still in the channel whose Session is `closed` creates a new Session (respawn, `session/new`) before routing the prompt; if that fails, drop the prompt, send a channel `NOTICE` that the Agent could not be started and keep the Agent in the channel
    - _Requirements: 9.14, 9.15, 9.16, 6.12, 6.13_

  - [x] 17.4 Handle hung agents
    - `src/session/hung-handler.ts`: on `{kind: "hung"}` send a `NOTICE` with the text `timeout` to every channel in which that process has a `prompting` Session, then let the harness `SIGTERM` and the rejected In_Flight_Prompts run the exit path
    - _Requirements: 9.13_

  - [x] 17.5 Write unit tests for Exorcism
    - Step order with `FakeHarness` (cancel before reset before close), idle Session skips cancel but still resets and closes, reset failure still closes and leaves, `PART`, `KICK` and `QUIT` triggers, only the exorcised channel is reset, branch and log kept, single-flight on duplicate triggers, `session/cancel` count seen from the harness is exactly one
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9_

  - [x] 17.6 Write unit tests for hung agents and exit
    - Fake timers: no frame for `SEANCE_PROMPT_TIMEOUT_MS` produces `timeout` notices, `SIGTERM` and rejected prompts; exit closes Sessions and drops queues; next prompt respawns; respawn failure notice
    - _Requirements: 9.12, 9.13, 9.14, 9.15, 9.16_

- [x] 18. Shutdown
  - [x] 18.1 Implement the shutdown sequence
    - `src/shutdown.ts`: idempotent (first call stores its promise, later calls return it); set `shuttingDown` so the resolver returns `false`, `onInvite` and every enqueue are refused without side effects; cancel every `prompting` Session and wait for each Cooldown; `harness.dispose()` (`SIGTERM`, `SIGKILL` after 5 s); close every virtual client; `TimerSet.clearAll()` on every owner, unsubscribe from host events, flush the `SessionStore` once; assert no timers or child processes remain; Worktrees are not touched
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9_

  - [x] 18.2 Write unit tests for shutdown
    - Sequence order, second call ignored and sequence runs once, invites and prompts refused while shutting down, `TimerSet.size === 0`, a worktree with uncommitted work is unchanged, a process that ignores `SIGTERM` gets `SIGKILL` after 5 s (fake timers)
    - _Requirements: 11.1, 11.2, 11.3, 11.5, 11.7, 11.8, 11.9_

- [x] 19. Composition root
  - [x] 19.1 Implement `createRunner`
    - `src/runner.ts`: `createRunner({host, config, logger, clock?, harness?, store?})`; `start()` runs `validateRunnerPaths`, loads the registry (non-zero failure via `NoAgentProfileError`), runs `verifyAgentFiles` (non-zero failure via `AgentFileMissingError`, before anything is spawned), selects `AcpHarness` for unset, empty or `acp` and `HeadlessHarness` for `headless` before spawning anything, subscribes to `irc.invite`, `irc.message`, `irc.mode`, `irc.kick`, and completes before accepting the first invite; `inviteResolver`, `ban(channel, nick)`, `unban`, `shutdown()`
    - Export `createRunner`, `loadRunnerConfig`, types and ports from `src/index.ts`
    - _Requirements: 1.1, 1.8, 1.11, 2.5, 2.6, 2.7, 3.1, 9.10, 11.1_

- [x] 20. Checkpoint - runner library
  - Ensure all tests pass, ask the user if questions arise.

- [x] 21. ircd changes (design D1 and wiring)
  - [x] 21.1 Publish `irc.message` from `deliverMessage`
    - In `apps/ircd/src/handlers/message.ts` publish `irc.message` `{channel, from, message}` after a successful channel delivery, for `PRIVMSG` and `NOTICE`; publish nothing when delivery fails (`404`, `403`, `+m` rejection)
    - This is the only change the runner needs inside the ircd core handlers
    - _Requirements: 5.1, 5.14, 3.7_

  - [x] 21.2 Write the ircd test for `irc.message`
    - In `apps/ircd/test`: a channel `PRIVMSG` and a channel `NOTICE` each publish exactly one `irc.message` with the right fields; a message rejected by `+m`, by `404` or by a missing channel publishes nothing; private messages publish nothing
    - _Requirements: 5.1, 5.14_

  - [x] 21.3 Add `runner-wiring.ts`
    - Add `"@seance/runner": "workspace:*"` to `apps/ircd/package.json` (run `pnpm install`); `apps/ircd/src/runner-wiring.ts` exports `createIrcHost(server: IrcServer): IrcHost` adapting `ctx.channels`, `ctx.connections`, `server.events.subscribe`, `createVirtualClient`, `modeOf`, and `noticeTo` (server-prefixed `NOTICE` via `Client.send`)
    - A drift between the ports and the ircd shapes must fail the ircd typecheck
    - _Requirements: 3.2, 3.12, 8.11_

  - [x] 21.4 Wire the runner in `apps/ircd/src/index.ts`
    - When `process.env["SEANCE_RUNNER"] === "1"`: declare `let runner`, create the server with the lazy resolver `(t, c, i) => runner?.inviteResolver(t, c, i) ?? false`, then `runner = createRunner({host: createIrcHost(server), config: loadRunnerConfig(process.env), logger})`, `await runner.start()` **before** `server.start()`, and call `runner.shutdown()` before `server.stop()` in the signal handler
    - A `ConfigError` or `NoAgentProfileError` is logged by the existing `main().catch` and exits with code 1 before listening
    - _Requirements: 1.1, 1.8, 2.7, 11.1_

- [x] 22. Integration tests against the Fake_Agent with an in-process ircd
  - Tests live in `apps/ircd/test/runner/` because only `apps/ircd` may depend on both packages without a cycle; they reference the Fake_Agent launcher by relative path and set `SEANCE_KIRO_BIN` to it

  - [x] 22.1 Add the integration fixture
    - Starts `createServer` on port 0 with the lazy resolver and a real `Runner` over `createIrcHost`, a temporary repository and workspaces root from `temp-repo`, `ManualClock` or fake timers, and a small TCP IRC test client (register, join, send, wait for a line); everything closed in `afterEach` and the temporary directories removed in `finally`
    - _Requirements: 12.6, 12.9, 12.10_

  - [x] 22.1b Write `agent-profile-not-loaded.integration.test.ts`
    - Fake_Agent scripted with `modeId: "kiro_default"`: `/invite coder` → `session/new` succeeds but the mode mismatches → the session is closed, the Fake_Agent process receives `SIGTERM`, the inviter receives the `NOTICE` `agent profile <name> not loaded`, the agent leaves with `PART`, the Invite_Key is released, and the Fake_Agent's recorded `session/prompt` count is 0 even after a human op sends a channel message; a second Agent in another channel is unaffected
    - Startup variant: a profile whose `agents/.kiro/agents/<kiroAgent>.json` is missing makes `runner.start()` reject with `AgentFileMissingError` and spawns no process
    - _Requirements: 1.11, 2.15, 2.16, 12.14_

  - [x] 22.2 Write `invite.integration.test.ts`
    - `/invite coder` → resolver claims → `341` → virtual client registered (`001`) → `JOIN` with no mode → worktree created → `session/new` with `cwd` = worktree; nick held by a non-agent gives a `NOTICE` and no state; a duplicate invite is silent; the sixth invite in a minute gets one rate-limit `NOTICE`; `SEANCE_INVITERS` refusal yields `401`; worktree or `session/new` failure leaves with `PART`, notices the channel and releases the key; invite after `/kick` starts with a resume summary
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.9, 3.10, 3.12, 3.13, 3.14, 3.16_

  - [x] 22.3 Write `message-flow.integration.test.ts`
    - A human op's channel message becomes a prompt and the scripted chunks come back as colored `PRIVMSG` lines; a voiced human's text arrives wrapped in `<untrusted>`; a `+m` channel and a no-mode Agent get no prompt; a private message goes to a separate Private_Session; the longest line (30-byte nick, 63-byte host, 200-byte channel) reaches a peer untruncated, tying `budgetFor` to the ircd's `clampTrailing`; agent text such as `/kick x` is not executed
    - _Requirements: 5.1, 5.3, 5.4, 5.7, 5.8, 5.9, 7.2, 7.5, 7.6, 7.8_

  - [x] 22.4 Write `permissions.integration.test.ts`
    - A scripted `session/request_permission` for a write is rejected for `+v`, allowed for `+o` inside the worktree, rejected outside it; a `/mode +o` between two requests changes the second answer; a denial produces one channel `NOTICE` under 512 bytes; the Fake_Agent records the answers
    - _Requirements: 8.2, 8.3, 8.5, 8.8, 8.9, 8.11_

  - [x] 22.5 Write `exorcism.integration.test.ts`
    - `/kick coder` during a turn: exactly one `session/cancel` seen from the agent, worktree reset to the last commit, log and branch kept, Agent leaves with `*** coder has been exorcised`; `/part` and `QUIT` triggers; a ban (`Runner.ban`) makes the next `/invite` return `401`
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.6, 9.7, 9.10, 9.11_

  - [x] 22.6 Write `hung-agent.integration.test.ts`
    - With fake timers: no frame for `SEANCE_PROMPT_TIMEOUT_MS` during a turn gives `timeout` in the channel and a `SIGTERM`ed process; a crash (`{crash: 1}`) closes the Sessions and leaves the Agent in the channel; the next message respawns and opens a new session; a failing respawn gives a `NOTICE` and keeps the Agent
    - _Requirements: 9.12, 9.13, 9.14, 9.15, 9.16_

  - [x] 22.7 Write `credits.integration.test.ts`
    - Scripted `_kiro.dev/metadata` credits accumulate and `/whois coder` shows `model`, `tools`, `status`, `credits` lines with two decimals; with `SEANCE_CHANNEL_CREDIT_CAP` exceeded the in-flight prompt is cancelled, each op gets one notice, prompts are dropped, and `/msg coder !reset-credits` from an op clears the block while a non-op gets the operator-rights `NOTICE`
    - _Requirements: 10.1, 10.4, 10.9, 10.10, 10.11, 10.12, 10.16_

  - [x] 22.8 Write `shutdown.integration.test.ts`
    - `runner.shutdown()` during a turn cancels it, waits for the Cooldown, terminates the Fake_Agent, closes the virtual clients so Agents leave their channels, and leaves zero child processes and zero timers; a second call is ignored; the worktree keeps uncommitted work
    - _Requirements: 11.1, 11.3, 11.4, 11.6, 11.7, 11.8, 11.9_

- [x] 23. Opt-in end-to-end test with real `kiro-cli`
  - [x] 23.1 Write `e2e.kiro.test.ts`
    - `describe.skipIf(process.env["SEANCE_E2E_KIRO"] !== "1")`: invite an agent, send one prompt, receive a non-empty answer, shut down within 10 000 ms, and assert zero `kiro-cli` child processes remain; vitest reports it as skipped otherwise
    - Also confirm the headless flags (`kiro-cli chat --no-interactive`) and the ACP tool kind values flagged as unverified in the design
    - _Requirements: 12.11, 12.12_

- [x] 24. Documentation deliverables
  - [x] 24.1 Add the README section for runner environment variables
    - Table in `README.md` for `SEANCE_RUNNER`, `SEANCE_HARNESS`, `SEANCE_TARGET_REPO`, `SEANCE_WORKSPACES`, `SEANCE_PROMPT_TIMEOUT_MS`, `SEANCE_CHANNEL_CREDIT_CAP`, `KIRO_API_KEY`, `SEANCE_INVITE_RATE`, `SEANCE_INVITERS`, `SEANCE_AGENTS_DIR`, `SEANCE_KIRO_BIN`, `SEANCE_E2E_KIRO`, each with default and validation; state that `KIRO_API_KEY` is read from the environment only
    - _Requirements: 2.6, 2.8, 3.18, 3.14, 4.7, 9.12, 10.9, 12.11_

  - [x] 24.2 Write `docs/DEMO_AGENT_RUNNER.md`
    - Manual checklist with irssi against `localhost:6667` reproducing `DESIGN.md` Journey A (`/join #fix-bug-123`, `/topic`, `/invite coder`, `/invite reviewer`, `/mode #fix-bug-123 +v coder`, `/mode #fix-bug-123 +o coder`) and Journey B (`/kick #fix-bug-123 coder scope creep`, `/invite coder`), plus the start command with the required env vars; each step lists the exact command and the expected output lines (for example `341`, the join line, `*** coder has been exorcised`, the resume summary reply)
    - _Requirements: 3.2, 3.5, 8.2, 9.1, 9.6, 3.7_

- [x] 25. Final checkpoint
  - Run `pnpm typecheck && pnpm test` and `pnpm lint` at the repository root; ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks 7.4, 9.5, 12.3 and 12.4 are required security tests (worktree config exclusion, the pre-prompt gate, permission purity and the protected-path rules); they carry no `*` marker.
- Tasks marked with `*` are optional unit tests and can be skipped for a faster MVP. The property tests (P1–P12), the ircd test for `irc.message`, the integration tests and the e2e test are not marked optional because the requirements demand them (Requirements 12.6, 12.8, 12.11).
- Task 0 blocks every other task. It needs the real `kiro-cli` and may spend credits. The spawn strategy does not depend on its result (Requirement 1.10).
- The Fake_Agent (task 4) is built before any harness, session or integration test; nothing in the automated suite starts `kiro-cli` or spends credits.
- Integration tests live in `apps/ircd/test/runner/` instead of `apps/runner/test` to avoid a package cycle (`@seance/ircd` depends on `@seance/runner`, never the reverse). Unit, property and fixture files stay in `apps/runner/test`.
- Requirement coverage: Requirements 1–12 (1.1–12.13) are each referenced by at least one task; property tasks reference their property and its requirements, matching the traceability table in `design.md`.
- A `docs/KIRO_USAGE.md` note is not a task; a hook handles it.
- Tests use `ManualClock` or fake timers; no wall-clock sleeps. Worktrees are created only in OS temporary directories and removed in `finally`.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["0.1"] },
    { "id": 1, "tasks": ["1.1"] },
    { "id": 2, "tasks": ["1.2", "3.1", "3.2", "4.1", "7.1", "8.1", "10.1", "12.1", "13.1", "16.2", "21.1"] },
    { "id": 3, "tasks": ["1.3", "2.1", "3.3", "3.4", "3.5", "4.2", "7.2", "7.3", "8.2", "8.3", "8.4", "9.1", "9.2", "10.2", "10.3", "11.1", "13.2", "16.4", "21.2"] },
    { "id": 4, "tasks": ["1.4", "2.2", "2.3", "3.6", "4.3", "5.1", "7.4", "10.4", "11.2", "13.3", "13.5", "16.1"] },
    { "id": 5, "tasks": ["5.2", "5.4", "5.5", "9.3", "11.4", "12.2", "13.4", "13.6", "16.3"] },
    { "id": 6, "tasks": ["5.3", "5.6", "9.4", "9.5", "11.3", "11.5", "12.3", "12.4", "13.7"] },
    { "id": 7, "tasks": ["15.1"] },
    { "id": 8, "tasks": ["15.2", "16.5", "17.1", "17.3", "17.4", "18.1"] },
    { "id": 9, "tasks": ["17.2", "17.5", "17.6", "18.2"] },
    { "id": 10, "tasks": ["19.1"] },
    { "id": 11, "tasks": ["21.3", "24.1"] },
    { "id": 12, "tasks": ["21.4", "22.1"] },
    { "id": 13, "tasks": ["22.2", "22.3", "22.4", "22.5", "22.6", "22.7", "22.8", "23.1", "24.2"] }
  ]
}
```
