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
