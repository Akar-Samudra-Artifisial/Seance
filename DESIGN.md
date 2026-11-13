# Séance — Design Document

> **"IRC is dead. Hold a séance."**
>
> A 1995-style IRC client and server, after the classic Windows IRC clients, for commanding a team of AI agents.
> Every AI agent is a user in a channel. The human operator runs the team with `/op`, `/kick` and `/topic`.

- **Hackathon:** Kiroween 2026 (Devpost), category **Resurrection**
- **Deadline:** 4 December 2026
- **License:** MIT
- **Working name:** Séance

---

## 1. Pitch

### Problem

Today's multi-agent UIs hide two things that matter most: **who is allowed to act** and **what is happening right now**. Permissions live in config files, activity lives in opaque spinners, and stopping a runaway agent is often a matter of killing a process.

### Insight

IRC solved this decades ago. Its semantics map almost one-to-one onto agent governance:

| IRC concept | Séance meaning |
|---|---|
| Channel | An isolated context/task — one git worktree per channel |
| Nick | Agent identity |
| `/whois` | Model, tools, and credits used |
| `+o` (op) | May write: edit files, `git commit`, run shell |
| `+v` (voice) | May speak in the channel |
| no mode | Listen only |
| `/kick` | Hard stop |
| `/ban` | Disable the agent (cannot be invited) |
| `/away` | Agent is busy (tool running) |
| Plaintext logs | Audit trail |
| Services (ChanServ, NickServ) | The runner's voice: status notices; the nicks are reserved (see "Services" in §3) |
| Open protocol | irssi/HexChat can connect too — humans and agents are peers |

### Resurrection angle

IRC semantics — modes, services, CTCP — are ideal primitives for agent governance. We bring a dead protocol back as the control plane for the newest kind of software.

**Demo moment:** irssi in a terminal kicks an agent that is actively working in the web client.

---

## 2. Persona & Journeys

**Persona:** a solo lead developer who wants to delegate work to several agents without losing control.

### Journey A — Fixing a bug in `#fix-bug-123`

1. `/join #fix-bug-123`
2. `/topic Fix NPE on login when email is null`
3. `/invite coder` and `/invite reviewer`
4. `coder` (voiced, `+v`) proposes a plan in the channel.
5. `/mode #fix-bug-123 +o coder` — coder may now write files and commit.
6. `reviewer` (voice only) can comment but cannot write.
7. `coder` sends `/notice` with a link to the diff.

### Journey B — Stopping scope creep

1. `/kick #fix-bug-123 coder scope creep`
2. The ACP session is cancelled, the worktree is reset to the last commit, the log is kept.
3. `/invite coder` again — the agent starts with a summary of the channel so far.

### Journey C — Classic clients are first-class

1. irssi connects to port 6667.
2. `/msg researcher summarize last 50 lines of #fix-bug-123`
3. `/whois coder` shows: model `sonnet-5.5`, tools `fs, git, shell(sandbox)`, credits used.

---

## 3. Features

### MVP

- Web client (retro UI).
- IRC server over TCP and WebSocket.
- Commands: `JOIN`, `PART`, `PRIVMSG`, `NOTICE`, `TOPIC`, `INVITE`, `KICK`, `MODE` (`+o`, `+v`, `+m`, `+n`, `+t`), `WHOIS`, `NAMES`, `LIST`, `AWAY`, `QUIT`, `PASS`, `NICK`, `USER`, `PING`, `PONG`.
- Channel modes: a new channel is `+nt`. `+n` (default on): only members may send to the channel (`404` otherwise). `+t` (default on): only operators set the topic (`482` otherwise). `+m` (default off): only `+v`/`+o` members may speak. One `MODE` command gives one grouped `MODE` line with the changes that altered state (for example `+mnt`, `+o-v coder bob`); `324` lists the flags alphabetically (`+nt`, `+mnt`).
- Three agents: `coder`, `reviewer`, `researcher`.
- One git worktree per channel.
- Persistent logs.
- Authentication via `PASS`.

### Command → agent mapping

| Command | Effect |
|---|---|
| `/invite <agent>` | Spawn/attach an ACP session in the channel's worktree |
| `/kick`, `/part` | `session/cancel` + reset worktree |
| `/ban` | Agent cannot be invited |
| `/topic` | Task statement given to agents |
| `+v` | Agent may speak |
| `+m` | Only `+v`/`+o` members may speak (saves credits) |
| `+n`, `+t` | On by default: no messages from outside the channel; only operators change the task (topic) |
| `+o` | Write tools enabled (edit, `git commit`, shell) |
| `/msg <agent>` | Private prompt |
| `/whois <agent>` | Model, tools, skills, status, credits |
| Agent skills | Kiro skills from `agents/.kiro/skills` only, a fixed list per agent, never from the target repo (spec `agent-skills`) |
| `/away` | Set automatically while a tool runs |
| `/list` | Channels with topic and member count |
| CTCP `VERSION` / `PING` | Model name / latency |

### Services (`ChanServ`, `NickServ`)

Spec: `.kiro/specs/runner-services`. The nicks `ChanServ` and `NickServ` are reserved: `NICK` with either (any letter case) is refused with `432`, and an agent profile may not use them. A service is not a user: it has no connection, no `WHOIS` and no place in `NAMES`. It exists as the prefix `ChanServ!ChanServ@services.<server>` of a `NOTICE` sent by the runner, so irssi and HexChat show `-ChanServ- text` like any notice. Service lines are never published as channel traffic, so agents never read them as prompt text. Messages sent to a service get `401`.

A notice is sent only when the fact behind it has just become true, and every number comes from the state behind `WHOIS`:

| Notice | When | Source |
|---|---|---|
| `-ChanServ- worktree ready: workspaces/<channel> @ <sha>` | the channel worktree is created (not when it is reused) | `WorktreeManager`, `git rev-parse --short=7 HEAD` |
| `-ChanServ- session cancelled, worktree reset to <sha>` (`session closed` when no prompt was in flight) | `/kick` or the agent's own `PART`, after the reset succeeded | exorcism, reset report |
| `-ChanServ- N files reverted · X.XX credits used` | same moment, when files were reverted or credits are above zero | `git status` before the reset, `CreditLedger` (same value as the `320 credits:` line) |
| `-NickServ- agents online: coder, reviewer, researcher (idle)` | a human finishes registering, while the runner is running | `AgentRegistry`, `WhoisSnapshot` status |

Differences from the mockup, on purpose:

- **Credits wording.** The mockup says `credits released`. A kick does not release credits (the ledger keeps the pair total so the channel cap survives kick and re-invite), so the line says `credits used`. Open for a product decision.
- **Worktree path.** The mockup shows `.seance/wt/<channel>`. The real layout is `SEANCE_WORKSPACES/<channel>`, shown as its last two path segments; absolute paths never go to IRC.
- **Restored sessions.** `2 sessions restored from last séance: ...` is not sent. Sessions live in memory and are lost on restart, and a persisted record could not resume the agent's conversation (ACP `session/load` is untested). It needs a persistent store and a spike first.
- **Scope warning.** `coder touched 6 files outside topic scope` is not built; there is no scope rule to base it on.
- Mockup values such as `a1b2c3d`, `6 files` and `4.1` are sample data. Credits show two decimals, like `WHOIS`.

The web client shows a service notice to the own nick in the Status window and one to a channel in that channel's window; it never opens a query window for a service.

### Agent-to-agent loop guard

Spec: `.kiro/specs/runner-services`, Requirement 11. A channel line from one agent becomes another agent's prompt only when it names that agent (the nick as a whole word, any case, colour codes ignored). Each agent may then answer other agents at most 3 times per channel; the next line from a voiced or op human in the channel resets the counts (lines from unmoded nicks and from agents never do). A dropped line is still logged in the channel log; the runner says nothing on IRC about it. Agent `NOTICE`s and private messages between agents never become prompts. Two voiced agents answering `ok` to each other therefore stop after one round, and agents that keep naming each other stop after three replies each.

### Nice-to-have

- ChanServ auto-invite based on topic
- `/dcc send` a diff
- `/ignore`, `/notify`
- `^K` color codes
- Scrollback search

### Out of scope

Multi-server, SASL, netsplits, federation, mobile.

---

## 4. Architecture

We write our own IRC server in TypeScript (a subset of RFC 2812) listening on TCP 6667 (TLS 6697 in production) and WebSocket 6680 (browsers block ports 6665-6669 as unsafe, so the WebSocket port must stay outside that range). Agents are **virtual clients in-process**.

**Why our own ircd:** roughly 20 commands and a single source of truth for state. A third-party ircd (e.g. ergo) would mean duplicated state and race conditions between the ircd and the agent runner.

**Fallback:** if milestone M1 slips by more than 3 days, switch to ergo + a bridge.

### Diagram

```
 irssi / HexChat ──TCP 6667──┐
                             ▼
 Web client (Next.js) ──WS──▶ ircd (Fastify + ws)   all IRC state in memory, in-process event bus
                             │                    ├─▶ IRCD_ACCOUNTS_FILE (scrypt hashes, read at start)
                             │                    └─▶ SEANCE_WORKSPACES/.seance-credits.json (credits, daily budget)
                             ▼
                      agent-runner
              (per agent: `kiro-cli acp --agent X`,
               cwd = workspaces/<channel>)
                             │  JSON-RPC over stdio:
                             │  session/new, session/prompt, session/cancel
                             ▼
                 workspaces/<channel>  (git worktree)
```

### Message flow

1. A user sends `PRIVMSG #ch :text`.
2. The ircd broadcasts it to channel members.
3. For every agent member with `+v`, the runner enqueues the prompt `[#ch] <nick(op)> text`.
4. ACP `session/update` stream chunks are buffered per sentence.
5. Each sentence is emitted as `PRIVMSG` from the agent's nick.
6. On a tool call: the agent is set `AWAY` automatically and a `NOTICE` is sent (e.g. `editing src/auth.ts`).

---

## 5. Kiro Integration

### Runtime

- **Primary:** ACP — `kiro-cli acp --agent <name>`; one process per agent, one session per channel.
- **Fallback:** `kiro-cli chat --agent <name> --no-interactive "<prompt>"` (env `KIRO_API_KEY`).
- Both sit behind an `AgentHarness` interface.
- **Credential in the podman sandbox:** a read-only mounted login (`SEANCE_SANDBOX_AUTH_DIR`), `KIRO_API_KEY`, or both; one is required at startup. The key goes into the container name-only (`podman run -e KIRO_API_KEY`) and its value travels only in the environment of that one `podman run` process, so it never appears in argv or `ps`. No other podman call gets it. When both are set the login wins (Kiro's own precedence) and the runner logs one warning.

### Kiro Crew

- Package the repo as a Crew App: `app.json` at the root, `agents/*.json`, `skills/irc-etiquette/SKILL.md`, `ui/`.
- Optional `KIRO_HARNESS=crew` via the Crew Gateway REST API (**not yet verified**; the MVP does not depend on it).

### `.kiro/` contents

- `steering/` — always on: product, tech, structure, security; by file match: irc-protocol, runner-acp, web-ui, testing.
- `specs/` — one folder per feature (requirements, design, tasks): `ircd-core`, `ircd-review-fixes`, `ircd-agent-commands`, `ircd-agent-commands-fixes`, `agent-runner`, `runner-services`, `agent-skills`, `agent-sandbox`, `public-hardening`, `web-client-basic`, `web-client-polish`, `web-client-pixel-match`, `web-client-extras`.
- `hooks/` — `guard-shell` (`PreToolUse` deny-list: `rm -rf` outside build dirs, `git push --force`, `git reset --hard`, `curl | sh`, paths outside the repo, printing secrets), `test-on-save`, `verify-after-task`, `kiro-usage-log`.
- `agents/` — the development agents `seance-dev`, `seance-reviewer`, `seance-spec`. The runtime agents `coder`, `reviewer`, `researcher` live in `agents/` at the repository root. There is no `chanserv` agent: ChanServ and NickServ lines are produced by runner code without a model call.
- `skills/` — `irc-rfc2812`, `acp-runner`, `kiroween-submission`.
- `settings/mcp.json` — Playwright and Context7.
- Property-based tests with fast-check, from the parser (`parse(serialize(m)) == m`) to nick reservation and redaction.

---

## 6. Data Model

There is no database. State lives in memory or in a few files:

| What | Where | Survives a restart |
|---|---|---|
| Users, nicks, channels, modes, topics, memberships | ircd memory (`ConnectionManager`, `ChannelRegistry`) | No |
| Channel history for prompts | runner memory (`ChannelLog`, bounded) | No |
| Sessions (agent, channel, ACP session id, status) | runner memory (`SessionManager`, `WhoisSnapshot`) | No |
| Credits per agent and channel, daily budget | `SEANCE_WORKSPACES/.seance-credits.json` (`CreditsFile`, atomic write, mode 0600) | Yes |
| Accounts | `IRCD_ACCOUNTS_FILE` (`<nick>:scrypt$...` lines, mode 0600, read at start) | Yes (operator file) |
| Agent profiles and skills | `agents/` in the repository | Yes |
| Work of the agents | git worktrees under `SEANCE_WORKSPACES/<channel>`, branches `seance/<channel>` | Yes |
| Kill switch | `SEANCE_WORKSPACES/.seance-paused` (exists = paused) | Yes |

`SessionStore` is an interface; the runner uses the credits file by default and `MemorySessionStore` in tests.

### Events

In-process `EventBus` of the ircd (no external broker): `irc.message`, `irc.mode`, `irc.kick`, `irc.invite`, `irc.register` and the other `irc.*` events the runner subscribes to through its host port.

---

## 7. UI

- MDI windows (status / channel / query). The active window is maximised into the frame like the Figma mockup: one title bar, the child icon and child buttons in the menu bar (spec `.kiro/specs/web-client-pixel-match`; layout metrics in `apps/web/src/layout/metrics.ts`).
- Icon toolbar with the Figma icons; IBM Plex Mono for chat, Arimo for chrome.
- Responsive: Desktop from 1024 px (Frame_01 metrics), Medium 768–1023 px (narrower nick list), Compact below 768 px (nick list overlay, `»` menu overflow, scrolling switchbar, input kept above the on-screen keyboard).
- Nick list on the right with `@` / `+` prefixes.
- `^K` color codes 0–15 (coder = 12, reviewer = 3).
- `[HH:MM]` timestamps; a "ding" when your nick is mentioned.
- Switchbar; an Options dialog for choosing models.

### Halloween touches

- ASCII jack-o'-lantern in the status window on connect.
- MOTD: "Server is haunted".
- "Ghost" palette (black / dim orange).
- `*** coder has been exorcised` on kick.

### Design-score factors

- Optional CRT scanlines.
- Keyboard-first: Tab completion, Alt+number to switch windows.
- Interactive `/help`.
- Accessible contrast.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| Credits | `+m` by default; per-channel credit cap; a global daily cap (`SEANCE_DAILY_CREDIT_CAP`, UTC day) and a kill-switch file, both persisted with the totals in `.seance-credits.json` (spec `public-hardening`); only `+v`/`+o` senders or the agent's inviter start a turn; agent-to-agent replies capped at 3 per human line (runner-services Req 11); Haiku for researcher, Sonnet for coder; ChanServ/NickServ cost nothing (runner code, no model) |
| Security | Shell only for `+o`; cwd locked to the worktree; deny-list hooks; Podman container (rootless, one per agent and session directory instead of one process per agent; spec `agent-sandbox`, [`docs/SANDBOX.md`](docs/SANDBOX.md); no git metadata inside it, so the runner commits an op agent's work on the host after each turn with hardened git; a commit command for ops is a later spec; egress limited to HTTPS towards Kiro and package registries by a host rule); only messages from human ops become instructions — everything else is wrapped in `<untrusted>`; agent output is never executed |
| Latency | Stream per sentence; 120 s timeout → `NOTICE` |
| Judge hosting | VPS + Podman + Caddy TLS; judge accounts via `PASS <nick>:<secret>` (`IRCD_ACCOUNTS_FILE`, scrypt hashes; guests via the server password cannot invite); nicks claimed only after `PASS`; max 2 active agent channels (`SEANCE_MAX_AGENT_CHANNELS`) and 6 sessions; real client IPs from `X-Forwarded-For` of trusted proxies for per-IP limits; `IRCD_PUBLIC=1` refuses to start until every item is set (spec `public-hardening`) |
| Trademark | Never use the trademarked name of the classic Windows IRC client in the product name, packages, logos or UI (rule in `.kiro/steering/product.md`) |
| Crew API | Not yet confirmed; MVP does not depend on it |

**Untested assumption:** ACP `session/cancel` cancels cleanly.

---

## 9. Plan

| Milestone | Dates | Scope |
|---|---|---|
| M1 | 6–13 Nov | Spec + steering; ircd with 12 core commands; two irssi clients can chat |
| M2 | 13–20 Nov | ACP runner, invite, `+v`/`+o`, kick, worktrees, basic web client |
| M3 | 20–27 Nov | Full UI, whois/away/list, credits, audit, hooks, deploy, Crew App manifest |
| M4 | 27 Nov–3 Dec | Polish, PBT, write-up, blog, video, buffer |

### Video (180 s)

| Time | Content |
|---|---|
| 0–15 s | Hook |
| 15–40 s | Connect + `/list` |
| 40–90 s | Journey A |
| 90–120 s | Kick from irssi (split screen) |
| 120–150 s | `/whois`, cost, hook blocking `rm -rf` |
| 150–175 s | How it was built with Kiro |
| 175–180 s | Outro |

---

## 10. Name Candidates

**Séance** (chosen), Revenant, Poltergeist, Ouija Chat, Necronet.

---

## 11. Stack

- **Tooling:** pnpm + Turborepo, TypeScript.
- `apps/ircd` — Fastify, `ws`, own parser.
- `apps/runner` — ACP client.
- `apps/web` — Next.js 16, Tailwind, Zustand.
- `packages/irc-protocol` — parser/serializer + property-based tests.
- No database and no message broker: in-memory state plus the credits and accounts files (section 6).
- Agents run in rootless Podman containers in production (`sandbox/`, [`docs/SANDBOX.md`](docs/SANDBOX.md)); the deployment itself (Caddy for TLS, the host setup) is spec `deploy-aws` ([`docs/DEPLOY.md`](docs/DEPLOY.md)).
- CI: GitHub Actions (`.github/workflows/ci.yml`).
- License: MIT.
