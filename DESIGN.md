# Séance — Design Document

> **"IRC is dead. Hold a séance."**
>
> A 1995-style, mIRC-inspired IRC client and server for commanding a team of AI agents.
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
| Services (ChanServ) | Orchestrator |
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
- Commands: `JOIN`, `PART`, `PRIVMSG`, `NOTICE`, `TOPIC`, `INVITE`, `KICK`, `MODE` (`+o`, `+v`, `+m`), `WHOIS`, `NAMES`, `LIST`, `AWAY`, `QUIT`, `PASS`, `NICK`, `USER`, `PING`, `PONG`.
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
| `+o` | Write tools enabled (edit, `git commit`, shell) |
| `/msg <agent>` | Private prompt |
| `/whois <agent>` | Model, tools, status, credits |
| `/away` | Set automatically while a tool runs |
| `/list` | Channels with topic and member count |
| CTCP `VERSION` / `PING` | Model name / latency |

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
 Web client (Next.js) ──WS──▶ ircd (Fastify + ws) ──▶ Postgres (logs, channels, agents, credits)
                             │                    └─▶ Redis (pub/sub, rate limiting)
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

### Kiro Crew

- Package the repo as a Crew App: `app.json` at the root, `agents/*.json`, `skills/irc-etiquette/SKILL.md`, `ui/`.
- Optional `KIRO_HARNESS=crew` via the Crew Gateway REST API (**not yet verified**; the MVP does not depend on it).

### `.kiro/` contents

- `steering/` — product, tech, structure.
- `specs/` — `ircd-core`, `agent-runner`, `web-client`, `permissions`.
- `hooks/` — `PreToolUse` hooks blocking `rm -rf`, `git push --force`, and access outside the worktree.
- `agents/` — `coder`, `reviewer`, `researcher`, `chanserv`.
- `powers/irc-protocol`.
- Property-based tests for the parser with fast-check: `parse(serialize(m)) == m`.

---

## 6. Data Model

| Table | Columns |
|---|---|
| `users` | `id`, `nick`, `kind` (`human` \| `agent`), `password_hash` |
| `agents` | `user_id`, `kiro_agent`, `model`, `tools[]`, `banned` |
| `channels` | `name`, `topic`, `worktree_path`, `mode_flags` |
| `memberships` | `channel_id`, `user_id`, `op`, `voice`, `away` |
| `messages` | `channel_id`, `from_user`, `kind` (`privmsg` \| `notice` \| `system`), `body`, `ts` |
| `sessions` | `agent_id`, `channel_id`, `acp_session_id`, `status`, `credits_used` |
| `audit` | `ts`, `actor`, `command`, `target`, `result` |

### Redis events

`irc.message`, `irc.mode`, `irc.kick`, `agent.spawn`, `agent.chunk`, `agent.tool`, `agent.done`, `credits.exceeded`.

---

## 7. UI

- MDI windows (status / channel / query) with Windows 95 title bars.
- 16px icon toolbar, Fixedsys-like font.
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
| Credits | `+m` by default; per-channel credit cap; Haiku for researcher/chanserv, Sonnet for coder |
| Security | Shell only for `+o`; cwd locked to the worktree; deny-list hooks; Podman container; only messages from human ops become instructions — everything else is wrapped in `<untrusted>`; agent output is never executed |
| Latency | Stream per sentence; 120 s timeout → `NOTICE` |
| Judge hosting | VPS + Podman + Caddy TLS; judge accounts via `PASS`; max 2 active agent channels |
| Trademark | Never use "mIRC" in the product name |
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
- `packages/db` — Prisma, Postgres.
- `compose.yaml` (Podman): ircd, runner, web, postgres, redis.
- License: MIT.
