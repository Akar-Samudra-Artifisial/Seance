# How Séance uses Kiro

Running log of Kiro features used while building Séance. It is raw material for the Kiroween 2026 write-up and video segment "How it was built with Kiro". The `kiro-usage-log` hook (`.kiro/hooks/kiro-usage-log.json`) appends an entry at the end of each agent turn that changed the repo; humans may add entries too.

## Kiro setup at a glance

| Feature | Where | Purpose |
|---|---|---|
| Steering (always) | `.kiro/steering/{product,tech,structure,security}.md` | Product goals, stack, layout, security rules |
| Steering (fileMatch) | `.kiro/steering/{irc-protocol,runner-acp,web-ui,testing}.md` | RFC 2812 rules, ACP findings, Win95/ghost design system, PBT rules |
| Specs | `.kiro/specs/ircd-core/` | Requirements (EARS), design with correctness properties P1–P9, tasks |
| Hooks | `.kiro/hooks/*.json` | `guard-shell` (PreToolUse deny-list), `test-on-save`, `verify-after-task`, `kiro-usage-log` |
| Custom agents | `.kiro/agents/seance-{dev,reviewer,spec}.json` | Implementation, read-only review, spec writing |
| Skills | `.kiro/skills/{irc-rfc2812,acp-runner,kiroween-submission}/` | On-demand reference material |
| MCP | `.kiro/settings/mcp.json` | Playwright (UI checks), Context7 (library docs) |
| ACP | `spikes/acp/`, `apps/runner` | Séance itself drives Kiro agents over `kiro-cli acp` as IRC users |
| PBT | `packages/irc-protocol` | fast-check properties from the spec (`parse(serialize(m)) == m`) |

## Entry template

```md
### YYYY-MM-DD — <short title>
- Kiro features: <spec | hook | steering | agent | MCP | skill | PBT> (<specific file or task>)
- Produced: <files or behavior>
- Notes: <anything notable for judges, or "none">
```

## Log

### 2026-11-06 — Design, first spec and ACP spike
- Kiro features: steering (product, tech, structure), spec (`ircd-core` requirements/design/tasks), ACP (`kiro-cli acp` spike)
- Produced: `DESIGN.md`, `.kiro/specs/ircd-core/`, `spikes/acp/` client + `FINDINGS.md` (session model, cancel cooldown, permission enforcement point)
- Notes: the spike retired the biggest risk — Kiro agents can be driven headlessly over ACP, several sessions per process.

### 2026-11-06 — Full `.kiro` workspace setup
- Kiro features: steering (fileMatch: irc-protocol, runner-acp, web-ui, testing; always: security), hooks (guard-shell, test-on-save, verify-after-task, kiro-usage-log), agents (seance-dev, seance-reviewer, seance-spec), skills (irc-rfc2812, acp-runner, kiroween-submission), MCP (Playwright, Context7)
- Produced: complete `.kiro/` folder, `AGENTS.md`, this log
- Notes: guard-shell blocks `rm -rf` outside build dirs, force-push, `git reset --hard`, `git clean -f`, `curl | sh`, paths outside the repo and printing secrets.

### 2026-11-06 — ircd-core task 1.1: IrcMessage type and parse()
- Kiro features: spec (ircd-core task 1.1), agent (spec-task-execution via the task orchestrator), hook (guard-shell)
- Produced: `packages/irc-protocol/src/parse.ts` (RFC 2812 `parse()`, `ParseError` sentinel, `isParseError`) plus 20 unit tests in `test/parse.test.ts`
- Notes: guard-shell blocked a `../../node_modules/.bin/tsc` path outside the package cwd; the agent reran from the repo root. All 21 tests pass.

### 2026-11-06 — ircd-core task 1.2: serialize()
- Kiro features: spec (ircd-core task 1.2), agent (spec-task-execution via the task orchestrator)
- Produced: `packages/irc-protocol/src/serialize.ts` (`serialize()`: trailing-param colon rule, single CRLF, throws over 512 UTF-8 bytes) plus unit tests in `test/serialize.test.ts`
- Notes: none

### 2026-11-06 — ircd-core task 3.1: Client and ConnectionManager
- Kiro features: spec (ircd-core task 3.1), agent (spec-task-execution via the task orchestrator)
- Produced: `apps/ircd/src/client.ts` (Client interface) and `src/connection-manager.ts` (case-mapped nick index, registration state machine, `broadcastToPeers`) plus 11 unit tests in `test/connection-manager.test.ts`
- Notes: none

### 2026-11-06 — ircd-core task 4.1: PASS, NICK, USER handlers
- Kiro features: spec (ircd-core task 4.1), agent (spec-task-execution via the task orchestrator)
- Produced: `apps/ircd/src/handlers/registration.ts` (464/462/431/432/433 errors, rfc1459 nick-in-use check, `onRegistrationComplete` hook for 4.2) plus 9 tests in `test/registration.test.ts`
- Notes: root `pnpm typecheck` timed out, so tsc and vitest ran per package (30 tests pass).

### 2026-11-06 — ircd-core task 4.2: welcome burst and MOTD
- Kiro features: spec (ircd-core task 4.2), agent (spec-task-execution via the task orchestrator)
- Produced: welcome burst 001–005 then 375/372/376 in `onRegistrationComplete` (`apps/ircd/src/handlers/registration.ts`), optional `motd`/`createdAt` on `RouterContext`, 5 new tests in `test/registration.test.ts`
- Notes: spec drift caught: tasks.md said 001–004 (Req 3.8) but requirements Req 3.9 requires 005, so 005 was added; root `pnpm typecheck` timed out, per-package runs pass (35 ircd + 56 protocol tests).

### 2026-11-06 — ircd-core task 4.4: PING/PONG and keep-alive timers
- Kiro features: spec (ircd-core task 4.4), agent (spec-task-execution via the task orchestrator)
- Produced: `apps/ircd/src/handlers/keepalive.ts` (PING→PONG, 461 without token), idle PING and `Ping timeout` close timers in `ConnectionManager`, router `touch()` on every input, 7 fake-timer tests in `test/keepalive.test.ts`
- Notes: turbo hung at "Finishing writing to cache..." after typecheck/test finished, so results were read from the background run; not yet wired into `src/index.ts` (task 8.4).

### 2026-11-06 — ircd-core task 5: channel and messaging handlers
- Kiro features: spec (ircd-core tasks 5.1–5.7), agent (spec-task-execution via the task orchestrator)
- Produced: `apps/ircd/src/handlers/{join,part,privmsg,notice,topic,names,list}.ts`, shared `message.ts` delivery path, `names.ts` 353 splitter, `topic-reply.ts`, tests in `apps/ircd/test/` (96 ircd tests pass)
- Notes: NOTICE reuses PRIVMSG delivery with all error replies suppressed; root `pnpm typecheck`/`test` timed out, so runs were per package; handlers not yet wired into `src/index.ts` (task 8.4).

### 2026-11-06 — ircd-core task 9.1: VirtualClient
- Kiro features: spec (ircd-core task 9.1), agent (spec-task-execution via the task orchestrator)
- Produced: `apps/ircd/src/virtual-client.ts` (`dispatch()` through `CommandRouter` with `serialize()` boundary check, `onMessage()` subscription), `IrcServer.createVirtualClient()` in `src/server.ts`, tests in `test/virtual-client.test.ts` (117 ircd tests pass)
- Notes: overlong/malformed agent messages are rejected before routing; root `pnpm typecheck`/`test` timed out, so runs were per package; parity test (9.2) still open.

### 2026-11-06 — Spec ircd-review-fixes: seven review findings
- Kiro features: spec (`ircd-review-fixes` requirements/design/tasks), steering (security, irc-protocol, testing), hook (guard-shell)
- Produced: virtual-client keep-alive/close fix, byte-clamped relays + TOPICLEN/KICKLEN, timing-safe PASS, USER validation, final close, flood/connection/registration/write-buffer limits, WS Origin allow-list; 49 tests in `apps/ircd/test/review-fixes.test.ts`
- Notes: guard-shell blocked a python heredoc and a `/tmp` write (outside repo); mutation check made 3 regression tests fail; root `pnpm typecheck`/`test` timed out, so runs were per package (166 ircd tests pass).

### 2026-11-06 — ircd-review-fixes design.md format fix
- Kiro features: spec (`ircd-review-fixes` design.md)
- Produced: added Architecture, Components and Interfaces, Data Models, Correctness Properties, Error Handling and Testing Strategy sections to `.kiro/specs/ircd-review-fixes/design.md`
- Notes: none

### 2026-11-06 — Spec ircd-agent-commands: design
- Kiro features: spec (`ircd-agent-commands` design.md), steering (irc-protocol, security, testing), PBT (properties P1–P6 planned)
- Produced: `.kiro/specs/ircd-agent-commands/design.md` covering AWAY/WHOIS/INVITE handlers, the sync InviteResolver, `normalizeHost`, the `reflectedReply` clamp and `Wire.isDestroyed()`
- Notes: the design was checked against the real `apps/ircd` source and found that `handleUser` drops the real name and that virtual clients had no injectable clock.

### 2026-11-06 — agent-runner requirements spec
- Kiro features: spec agent-runner (requirements-first workflow, requirements.md), requirement-detailer sub-agents refined all 12 requirements, PBT properties P1–P6 stated as FOR ALL criteria
- Produced: .kiro/specs/agent-runner/requirements.md and .config.kiro (EARS, glossary, 12 requirements)
- Notes: none

### 2026-11-06 — Spec ircd-agent-commands: tasks
- Kiro features: spec (`ircd-agent-commands` tasks.md), PBT (sub-tasks for properties P1–P6)
- Produced: `.kiro/specs/ircd-agent-commands/tasks.md` with 16 tasks, 4 checkpoints and a 9-wave Task Dependency Graph
- Notes: each handler registers its command as it lands so tests run through the real server; the final checkpoint runs `pnpm typecheck && pnpm test`.

### 2026-11-06 — Bugfix ircd-agent-commands-fixes: six review findings
- Kiro features: spec (`ircd-agent-commands-fixes` bugfix/design/tasks), agent (seance-dev), PBT (P1 invited-set invariant, P2 WHOIS 318, P3 AWAY, P4 preservation), steering (testing, irc-protocol)
- Produced: invited-set cleanup on PART/KICK/QUIT/NICK with a 100-entry cap, validated and capped `whoisExtra` with a guaranteed 318, trimmed AWAY, `targetKey`/`targetOnline` plus 301 on INVITE, shared reply helpers, ECONNRESET/EPIPE logged at debug (482 ircd tests pass)
- Notes: 43 exploration tests failed first on unfixed code; the old P3 away model counted " " as away, which was the bug; `pnpm --filter … test -- --run <file>` runs the whole package, so single files use `exec vitest run`.

### 2026-11-06 — agent-runner requirements: invite hardening
- Kiro features: spec agent-runner (requirements.md update via spec workflow sub-agent)
- Produced: invite dedup + per-inviter rate limit (SEANCE_INVITE_RATE), SEANCE_INVITERS allow-list, synchronous snapshot-only whoisExtra; new glossary terms
- Notes: none

### 2026-11-06 — agent-runner requirements analysis
- Kiro features: spec agent-runner (analyze requirements, requirements.md update)
- Produced: Requirement 1.10 made unconditional (agent process cwd = agent definitions dir, worktree as session cwd); Requirement 9.9 exorcism leave message independent of worktree reset result
- Notes: first two analysis calls aborted, third succeeded with 2 clarifying questions

### 2026-11-06 — agent-runner design
- Kiro features: spec agent-runner (design.md via spec workflow sub-agent), PBT properties P1–P12
- Produced: .kiro/specs/agent-runner/design.md (architecture, ports, state machine, permission policy, fake ACP agent, traceability table)
- Notes: design found the ircd never publishes irc.message and skips the InviteResolver for online targets; runner-side fallbacks recorded as D1–D10

### 2026-11-06 — agent-runner tasks
- Kiro features: spec agent-runner (tasks.md via spec workflow sub-agent), PBT tasks for P1–P12, Task Dependency Graph
- Produced: .kiro/specs/agent-runner/tasks.md (26 top-level tasks, Task 0 spike first, 14 dependency waves)
- Notes: integration tests placed in apps/ircd/test/runner to avoid a package cycle; no lint script exists in the repo yet

### 2026-11-06 — agent-runner task 0.1: agent file resolution spike
- Kiro features: spec (agent-runner task 0.1), agent (spec-task-execution via the task orchestrator), ACP (`kiro-cli acp` spike S8)
- Produced: `spikes/acp/src/s8-agent-resolution.ts`, `s8` script, and the "S8: agent file resolution" section in `spikes/acp/FINDINGS.md`
- Notes: agent files resolve from the process cwd only; a missing file silently falls back to `kiro_default`, so the runner should check `modes.currentModeId`.

### 2026-11-08 — web-client-polish review fixes
- Kiro features: spec (web-client-polish review findings), steering (web-ui, security: untrusted window names), PBT (explicit 15 s timeouts on P1/P4)
- Produced: bidi/invisible stripping in labels and `formatter.ts`, 120-char topic clip in titles, lag clamp and reset, Reconnect gated on `ui.hasConnected`, macOS Option+letter left to the Input_Line, narrow store subscriptions (`useShallow`), ghost glyph on exorcised nick rows; tests in `review-fixes.test.tsx`, `lag.close.test.ts`, `selectors.review.test.ts`
- Notes: build, typecheck, lint, `test --force` and Playwright e2e (8 tests) all pass

## Next specs to generate in Kiro

These specs are intentionally **not** written yet: generate them in Kiro IDE (Spec mode, or the `seance-spec` agent in Kiro CLI) so the spec-driven workflow is visible in the write-up. Paste each prompt as is.

### agent-runner

```text
Create a spec named "agent-runner" from DESIGN.md §4–5 and spikes/acp/FINDINGS.md, following the structure of .kiro/specs/ircd-core.
Scope: apps/runner. One `kiro-cli acp --agent <name>` process per agent, one ACP session per channel with cwd = workspaces/<channel> (git worktree per channel).
Cover: AgentHarness interface (ACP primary, `kiro-cli chat --no-interactive` fallback); agents join as ircd VirtualClients; /invite spawns or attaches a session; PRIVMSG → prompt "[#ch] <nick(op)> text" for voiced agents; streamed chunks emitted as PRIVMSG per sentence under 512 bytes; tool calls set AWAY and send a NOTICE; /kick and /part = session/cancel + 1 s cooldown + worktree reset, log kept; re-invite starts with a channel summary; /ban blocks invites; SIGTERM for hard stop; credits from _kiro.dev/metadata.meteringUsage into sessions.credits_used; 120 s timeout → NOTICE; untrusted wrapping of non-op input.
Include correctness properties for the session state machine (no cancel without an in-flight prompt, no prompt during cooldown, at most one in-flight prompt per session) and tasks that reference requirement IDs.
```

### web-client

```text
Create a spec named "web-client" from DESIGN.md §7 and .kiro/steering/web-ui.md, following the structure of .kiro/specs/ircd-core.
Scope: apps/web (Next.js 15, Tailwind, Zustand) connecting to the ircd over WebSocket using @seance/irc-protocol for parsing.
Cover the Figma frames 01 Main, 02 Connect, 03 Kick, 04 Whois+Options, 05 Channel list, 06 Classic: MDI windows (status/channel/query) with Win95 title bars, switchbar, toolbar, nick list with @/+ prefixes, [HH:MM] timestamps, nick colors, mention ding, connect dialog with PASS, /list channel browser, whois panel with model/tools/credits, options dialog for models, kick "exorcised" message, ASCII jack-o'-lantern and haunted MOTD, optional CRT scanlines.
Accessibility and keyboard: WCAG AA contrast, Tab nick completion, Alt+number window switching, interactive /help, prefers-reduced-motion. Never use the word "mIRC".
Include testable acceptance criteria, a component/state design, correctness properties for the message store (ordering, per-window routing), and tasks including Playwright MCP visual checks against the Figma frames.
```

### permissions

```text
Create a spec named "permissions" from DESIGN.md §1, §3, §8 and .kiro/steering/security.md, following the structure of .kiro/specs/ircd-core.
Scope: how IRC modes govern agent capabilities across apps/ircd and apps/runner.
Cover: +o = write files, git commit and shell inside the channel worktree; +v = speak only; no mode = listen only; +m default for agent channels; enforcement in the ACP session/request_permission handler (allow_once / reject_once) with path confinement to workspaces/<channel>; never --trust-all-tools; .kiro PreToolUse deny-list hooks for agent sessions; /ban; only human ops' messages become instructions, all other text wrapped in <untrusted>; agent output never executed; per-channel credit cap and credits.exceeded event; audit table entries for every mode change, kick, permission decision and blocked tool call; judge accounts via PASS and max 2 active agent channels.
Include correctness properties (e.g. no write tool call is ever allowed for a non-op; every permission decision produces exactly one audit row) and tasks that reference requirement IDs.
```

### 2026-11-06 — agent-runner spec update from FINDINGS S8 and new spike S9
- Kiro features: spec agent-runner (requirements.md, design.md, tasks.md)
- Produced: fail-closed agent resolution (startup file check 1.11, `currentModeId` check 2.15–2.16, Fake_Agent `modeId`, req 12.14, tests), spike task 0.2 (S9: steering/hooks in session cwd) with a conditional hooks-exclusion follow-up
- Notes: none

### 2026-11-06 — spike S9: workspace config from the ACP session cwd
- Kiro features: `kiro-cli acp` driven by `spikes/acp/src/s9-session-cwd-config.ts` (6 Haiku prompts, `pnpm --filter @seance/spike-acp s9`); spec agent-runner updates
- Produced: `spikes/acp/FINDINGS.md` section "S9: workspace config from the session cwd" (AGENTS.md and skills in the session cwd are loaded; steering, hooks and MCP were not), Requirement 4 criterion 12 with design and tasks 7.3/7.4 updates
- Notes: hooks/MCP "not loaded" holds only for the tested hook format and profile settings

### 2026-11-06 — S9 spike wired into spec agent-runner
- Kiro features: spec agent-runner (task 0.2, requirement 4.12, design Worktrees step 4, tasks 7.3/7.4), skill acp-runner, hook guard-shell
- Produced: `spikes/acp/src/s9-session-cwd-config.ts`, `s9` script, FINDINGS.md section S9; AGENTS.md and skills load from the session cwd, so worktrees exclude `/.kiro/` and `/AGENTS.md`
- Notes: hook guard-shell blocked two shell commands (a `~/.kiro` mention and a temp script outside the repo)

### 2026-11-06 — agent-runner hardening: protected paths, prompt gate, spike S10
- Kiro features: spec agent-runner (requirements 4.12–4.14 and 8.14–8.16, design Worktrees steps 4–5 and P4, tasks 0.3, 7.3, 7.4, 9.3, 9.5, 12.1–12.4), hook guard-shell
- Produced: `spikes/acp/src/s10-nested-config.ts` (`s10` script) and FINDINGS section S10; security tests 7.4, 9.5, 12.3, 12.4 made required
- Notes: S10's mid-session AGENTS.md result is confounded (code present in the turn 1 prompt); guard-shell blocked a command reading the OS temp directory
### 2026-11-06 — agent-runner: remaining test tasks via run-all-tasks
- Kiro features: spec agent-runner (run-all-tasks orchestrator, tasks 1.4, 2.3, 2.5, 3.6, 4.3, 5.6, 9.4, 10.4, 11.5, 15.2, 17.5, 17.6, 18.2), PBT (P5, P6, P8, P9), agent (spec-task-execution)
- Produced: unit and property tests in `apps/runner/test` (config, registry, verify-agent-files, acp-client, fake-agent, harness, session, prompt, output, session-manager, exorcism, hung-and-exit, shutdown, P5/P8/P9); all 118 tasks complete
- Notes: sandbox shell was flaky so each test file ran on its own; a type error in output.test.ts was caught and fixed; no full-monorepo `pnpm test` run yet

### 2026-11-07 — agent-runner hardening after security review
- Kiro features: direct implementation turn (no workflow), regression tests per fix
- Produced: allow-listed child env (agents, git), redaction and C0 stripping on all agent output, SEANCE_INVITERS loopback gate and private-session gate/limits, SIGTERM->SIGKILL escalation on detached process groups, committed AGENTS.md/.kiro detection with reset to base, case-insensitive sparse patterns, generic invite-failure NOTICE, unpaced permissions integration test
- Notes: none

### 2026-11-07 — vitest timeouts for loaded machines
- Kiro features: direct edit of apps/runner/vitest.config.ts and apps/ircd/vitest.config.ts, verified with two `pnpm test --force` runs
- Produced: runner testTimeout/hookTimeout 30 s, ircd testTimeout 20 s; no test logic changed
- Notes: both forced runs passed (runner 380, ircd 536 + 2 skipped); machine was not heavily loaded, so the timeouts were not stress-tested

### 2026-11-07 — real kiro-cli permission shape + worktree race
- Kiro features: skill acp-runner, steering runner-acp; real ACP frames from spikes/acp/out/S10-H as test fixtures
- Produced: per-session tool_call cache + rawInput inference (harness/tool-info.ts), kiro-shaped Fake_Agent (legacy option), single-flight WorktreeManager.ensure, back-to-back invite integration test
- Notes: the real-kiro demo found both bugs that the Fake_Agent hid; every new test was confirmed failing with its fix reverted

### 2026-11-07 — kiro 3.1 permission fixes (spike S11)
- Kiro features: skill acp-runner, steering runner-acp, spec agent-runner Req 8.15 / design P4 (PBT), spike S11 against real kiro-cli 3.1.0 (2 prompts)
- Produced: kiro-3.1 frame fixture, info log per permission decision, diff paths dropped from decisions, `strReplace` inference, literal-only shell protected-path rule
- Notes: S11 showed kiro roots the diff path at its process cwd (also in 3.0), which caused the false outside-worktree; new tests confirmed failing with the fixes reverted

### 2026-11-07 — Spec web-client-basic: requirements
- Kiro features: spec (`web-client-basic` requirements.md, requirements-first workflow), requirement-detailer sub-agents (all 18 requirements refined), steering (web-ui, irc-protocol, security, testing, tech)
- Produced: `.kiro/specs/web-client-basic/` with `.config.kiro` and `requirements.md` (18 EARS requirements for the M2 browser client); the refined text is not merged yet, so the file holds the first draft
- Notes: hook guard-shell blocked the merge write (a `~` in the text) and a retry timed out; the refinement also found a CSP-vs-Connect-dialog conflict and that the runner exorcises with PART, not KICK

### 2026-11-07 — Spec web-client-basic: requirements update and design
- Kiro features: spec (`web-client-basic` requirements.md update, design.md), steering (web-ui, security, tech), MCP (Context7 for Next.js 16 proxy.ts CSP nonce, Tailwind 4, Zustand 5), PBT (properties P1–P20 planned)
- Produced: requirements for paced multi-line paste with no CR/LF/NUL on the wire, nonce CSP via proxy.ts with connect-src from NEXT_PUBLIC_IRCD_WS_URL, M2 Figma scope; design.md with core/store/UI layers, state types, component tree and Figma mapping
- Notes: reading the runner showed a human /kick yields KICK, not the "exorcised" PART, so the e2e asserts the KICK line

### 2026-11-07 — Spec web-client-basic: tasks
- Kiro features: spec (`web-client-basic` tasks.md, requirements-first workflow), PBT (one test task per property P1–P20), Task Dependency Graph
- Produced: `.kiro/specs/web-client-basic/tasks.md` ordered so the first runnable slice is connect → status window → join → chat against the real ircd, then full core, UI, CSP proxy, docs and the opt-in Playwright e2e
- Notes: only non-demo polish is optional (mention sound, component tests, extra a11y); the e2e starts with a spike on importing the ircd in-process under Playwright

### 2026-11-07 — web-client-basic: agent kick rendered as exorcism
- Kiro features: spec (`web-client-basic` requirements R8.14, R8.18, R13.5, R17.12, R17.19; design Open Point 1; tasks 6.3, 6.13, 6.14, 11.1, 16.3), PBT (new property P21)
- Produced: KICK of a Known_Agent (coder, reviewer, researcher) renders client-side as "*** <agent> has been exorcised by <kicker> (<reason>)" via classifyLine, with one shared KNOWN_AGENTS list
- Notes: closes the design gap where a human /kick never produced the runner's exorcism PART; no runner change

### 2026-11-07 — web-client-basic: tasks synced with requirements and design
- Kiro features: spec (`web-client-basic` tasks.md consistency pass against requirements.md and design.md), PBT (P16 nonce uniqueness, P21 ordering)
- Produced: uncovered criteria added (disallowed server URL in Store tests, Ircd origin accept/refuse in e2e, /query and /msg windows), resetForReconnect wired into the Store, rebuilt dependency waves
- Notes: the pass found no stale requirement references; same-file tasks no longer share a wave

### 2026-11-07 — web-client-basic: Kiro usage and Figma frame mapping
- Kiro features: spec (`web-client-basic` requirements.md, design.md, tasks.md via the requirements-first workflow, with requirement-detailer sub-agents), steering (`.kiro/steering/web-ui.md` for the Win95/ghost design system and frame names; `security`, `irc-protocol`, `tech`, `testing` for CSP, protocol and test rules), agents (the task orchestrator dispatching spec-task-execution subagents, one task at a time; `seance-dev`, `seance-reviewer`, `seance-spec` available), hooks (`guard-shell` PreToolUse deny-list, `test-on-save`, `verify-after-task`, `kiro-usage-log`), MCP (Context7 for Next.js 16, Tailwind 4 and Zustand 5 docs; Playwright for the opt-in e2e), PBT (properties P1–P21 with fast-check)
- Produced: the spec under `.kiro/specs/web-client-basic/`, the M2 browser client in `apps/web`, and an opt-in Playwright e2e that runs against the real ircd
- Figma: the frame-to-component mapping below is derived from the frame names in `.kiro/steering/web-ui.md` and the requirements, as recorded in the "Figma frame mapping" table in `design.md`. No Figma MCP calls are claimed here, and layout details were not verified against the frames.
- Notes: only these frames are in M2 scope; the rest of `04 Whois+Options`, `05 Channel list` and `06 Classic` are M3.

| Figma frame | Components | Requirements |
|---|---|---|
| `01 Main` | `ClientApp`, `MenuBar`, `Toolbar`, `Mdi`, `WindowFrame`, `ChannelWindow`, `TopicBar`, `ChatBuffer`, `ChatLine`, `NickList`, `Switchbar`, `InputLine`, `StatusBar` | R5, R6, R7, R8, R13 |
| `02 Connect` | `ConnectDialog` (nick, server URL, optional password, inline errors, Reconnect button) | R3, R4, R14.5, R14.6 |
| `03 Kick` | `ChatLine` kick and exorcism styles via `classifyLine`, `NickList` after the agent leaves | R8.13, R8.14, R8.18, R13.5 |
| `04 Whois+Options` (Whois panel only) | `WhoisBlock` rendered inside `ChatBuffer` | R9.2, R9.3, R13.4 |

### 2026-11-07 — web-client-basic: run all tasks to completion
- Kiro features: spec web-client-basic (run-all-tasks orchestrator, 86 of 89 tasks via spec-task-execution subagents, all required tasks), PBT (P1–P21 fast-check properties), hook guard-shell
- Produced: apps/web client (IRC core, Store, UI, CSP proxy.ts), vitest suite (358 tests), opt-in Playwright e2e (smoke, chat flow, CSP), docs and README
- Notes: P6 property test found a crash on `/__proto__` in parseInput (fixed with Object.hasOwn); e2e showed that messages sent before the agent session exists are dropped silently; guard-shell blocked some shell commands; optional tasks 11.7, 11.9, 14.3 skipped

### 2026-11-07 — web-client-basic: remaining tasks 11.7, 11.9, 14.3

- Kiro features: spec web-client-basic (tasks 11.7, 11.9, 14.3 via spec-task-execution sub-agents in parallel)
- Produced: optional mention sound (Store `setMentionSound`, menu toggle, browser audio adapter), ChatBuffer a11y test, skip link and unread live-region announcer with tests
- Notes: all 89 tasks now complete; the earlier entry said these three were skipped.

### 2026-11-07 — web-client-basic review fixes
- Kiro features: spec (`web-client-basic` review findings), steering (security, web-ui, testing), PBT (updated P1/P2/P15/P19 for namespaced keys), hook (guard-shell)
- Produced: null-prototype records, `c:`/`q:` window keys, 50-item caps, `dispose()`, frame and URL guards, security headers, `formatIrc` rename; new `reducer.keys.test.ts` and `lifecycle.test.ts`
- Notes: existing property tests caught the key and URL-suffix changes; 398 web tests, build, lint, typecheck and e2e pass.

### 2026-11-07 — Spec web-client-polish from Figma frames
- Kiro features: spec (`web-client-polish` requirements/design/tasks), MCP (Talk-to-Figma channel `8p9g0i9k`: `get_node_info` on 01 Main, `export_node_as_image` on 00, 01, 02, 03, 04), steering (web-ui, security, testing), PBT (properties P1–P8 planned)
- Produced: `.kiro/specs/web-client-polish/` with 18 requirements, measured 01 Main layout, 8 properties and a 7-wave task graph
- Notes: the Figma power `get_design_context` was not called because the URL was the unfilled placeholder `<FIGMA_FILE_URL>`; ircd gaps (no AWAY broadcast, channel modes only `m`) are recorded as Open Points.

### 2026-11-07 — Web dev setup fixes: bad port, webpack dev, dev CSP
- Kiro features: steering (security, irc-protocol, testing), spec edits (`web-client-basic` design/requirements/tasks port 6668 to 6680), PBT (`csp.property.test.ts` updated for the dev style-src)
- Produced: default ircd WS port 6680 everywhere, `loadConfig` refuses WS ports 6665-6669, `next dev --webpack`, dev `style-src 'self' 'unsafe-inline'` without nonce (production keeps the nonce), new ircd, CSP and proxy tests
- Notes: manual browser testing found ERR_UNSAFE_PORT on 6668 and blocked dev CSS; a nonce in style-src makes browsers ignore `'unsafe-inline'`. `apps/web/AGENTS.md` (generated by `next dev`) is kept as is.

### 2026-11-07 — web-client-polish tasks.md format fix
- Kiro features: spec (`web-client-polish` tasks.md)
- Produced: added the missing `## Notes` section to `.kiro/specs/web-client-polish/tasks.md` (dev setup and verification rules moved out of the Overview)
- Notes: none

### 2026-11-07 — web-client-polish: Figma sources and parallel task runs
- Kiro features: spec (`web-client-polish` requirements/design/tasks), MCP (Talk-to-Figma), agent (run-all-tasks orchestrator dispatching spec-task-execution sub-agents, several in parallel per wave), PBT (P1–P8 fast-check properties), MCP (Playwright for the manual visual check)
- Figma sources: Talk-to-Figma channel `8p9g0i9k`, frames `00 Style guide` (1:4830), `01 Main` (1:1093), `02 Status/MOTD` (1:2153), `03 Kick` (1:4655), `04 Whois` (1:2947), read with `get_node_info` and `export_node_as_image`.
- Skipped: the Figma power `get_design_context` call, because no Figma file URL was available (only the placeholder `<FIGMA_FILE_URL>`). Token values come from `get_node_info` on the style guide frame.
- Parallel spec-task-execution runs, by wave of the task graph:
  - Wave 0: tasks 1.1 (tokens), 2.1 (modes), 2.3 (away), 2.5 (credits)
  - Wave 1: tasks 1.2 (icons, scrollbars), 1.3 (fonts), 2.2, 2.4, 2.6 (property tests for modes, away, credits), 2.7 (prefix, exorcised nicks)
  - Later waves: selectors (2.8, 2.9), Store lag and minimise (3.1–3.3), chrome (4.1–4.3), MDI/switchbar/status bar/topic bar (5.1–5.5), chat surfaces (6.1–6.6), e2e (7.1)
- Produced: title bar, menu bar, toolbar, MDI child windows with minimise tray, switchbar credits counter, status bar lag, mode and away tracking, line-based WHOIS, exorcism line; `apps/web/README.md` documents the new chrome and its disabled items.
- Notes: the visual comparison (task 7.2) is manual and not part of `pnpm test`.
