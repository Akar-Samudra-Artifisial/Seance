# Requirements Document: public-hardening

## Introduction

Before the deploy-aws spec puts Séance on the internet for the Kiroween judges, the ircd and the runner must be safe to expose. A security review found nine gaps, each verified in code. This spec closes them: authentication before a nick is claimed, accounts for inviters, prompt gating by mode, a global credit budget with a kill switch, Kiro token redaction, real client addresses behind Caddy, a stricter public start-up guard, and bounded host git.

## Glossary

- **Auth_Mode**: the ircd has a server password, an accounts file, or both.
- **Account**: a line `<nick>:<hash>` in `IRCD_ACCOUNTS_FILE`. Logging in with `PASS <nick>:<secret>` authenticates it.
- **Guest**: a client that logged in with `PASS <server password>`.
- **Reserved_Nick**: an Account nick or an agent registry nick (`coder`, `reviewer`, `researcher`).
- **Inviter**: an authenticated Account allowed by `SEANCE_INVITERS` to invite agents.
- **Trusted_Proxy**: a socket peer address listed in `IRCD_TRUSTED_PROXIES`.
- **Turn**: one prompt to an agent and its streamed answer.

## Requirements

### Requirement 1: Authentication before the nick is claimed

**User Story:** As the operator of a public server, I want a nick to be taken only by a client that has logged in, so that nobody can squat on `coder` or an operator's nick.

#### Acceptance Criteria

1. WHILE in Auth_Mode, THE ircd SHALL record `NICK` and `USER` from an unregistered network client without claiming the nick, and SHALL claim the nick only when registration completes after a successful `PASS`.
2. WHILE in Auth_Mode, IF registration completes without a successful `PASS`, THEN THE ircd SHALL reply `464` and close the connection.
3. THE default registration timeout SHALL be 15 seconds (`IRCD_REGISTRATION_TIMEOUT_MS` still overrides it).
4. WHEN a connection has sent three wrong `PASS` values, THE ircd SHALL reply `464` and close it.
5. In-process (virtual) clients SHALL need no `PASS` and SHALL be allowed Reserved_Nicks.

### Requirement 2: Accounts

**User Story:** As an operator, I want named accounts with hashed secrets, so that only known people can invite agents.

#### Acceptance Criteria

1. THE ircd SHALL read `IRCD_ACCOUNTS_FILE` at start: one `<nick>:<hash>` per line, with blank lines and `#` comments allowed. THE hash SHALL be `scrypt$<N>$<r>$<p>$<salt b64>$<key b64>`.
2. IF the accounts file is readable by group or others, is not a regular file, or has an invalid line, THEN THE ircd SHALL refuse to start with a message naming `IRCD_ACCOUNTS_FILE` (and the line number, never the hash).
3. WHEN `PASS <nick>:<secret>` matches an Account, THE client SHALL be authenticated as that Account. Its `NICK` SHALL equal the Account nick (case-mapped), otherwise `432`.
4. WHEN `PASS <server password>` matches, THE client SHALL be a Guest. A Guest SHALL get `433` for an Account nick and `432` for an agent registry nick, at registration and on a later `NICK`.
5. An authenticated Account SHALL NOT change its nick (`432`).
6. A `tools/` script SHALL create a hash from a secret read on stdin. No secret or hash SHALL be committed.
7. Secrets SHALL be compared through scrypt with `timingSafeEqual`, and verification SHALL NOT block the event loop.

### Requirement 3: Inviters are accounts

#### Acceptance Criteria

1. WHILE accounts are configured, THE runner SHALL accept an `INVITE` of an agent, a private session and `!reset-credits` only from a client authenticated as an Account that `SEANCE_INVITERS` lists (or any Account when `SEANCE_INVITERS` is unset).
2. WHILE accounts are configured, IF an entry of `SEANCE_INVITERS` is not an Account nick, THEN THE runner SHALL refuse to start with a message naming `SEANCE_INVITERS` and the entry.
3. `!reset-credits` SHALL clear a block only for a sender that is both `+o` in that channel and an Inviter. The NOTICE SHALL say why otherwise.

### Requirement 4: Prompt gating

#### Acceptance Criteria

1. A channel message SHALL start an agent Turn only when its sender is `+v` or `+o` in the channel, or is the nick that invited that agent into the channel. Other messages SHALL be logged in the channel log and debug log and SHALL never prompt.

### Requirement 5: Credits, budget and limits

#### Acceptance Criteria

1. WHEN the runner is created without an injected store, THE ledger SHALL persist to `<SEANCE_WORKSPACES>/.seance-credits.json`, written atomically (temp file and rename, mode 0600), and SHALL be restored from it at start.
2. `SEANCE_DAILY_CREDIT_CAP` (finite, > 0) SHALL cap the credits of all agents per UTC day. WHEN the day's total exceeds it, THE runner SHALL cancel prompting Turns, send `-ChanServ- daily credit budget reached` once per day to every channel with a Session, and refuse new Turns until the next UTC day. THE day's total SHALL survive a restart.
3. WHEN the file `SEANCE_KILL_SWITCH_FILE` exists (default `<SEANCE_WORKSPACES>/.seance-paused`), THE runner SHALL refuse new Turns.
4. WHOIS of an agent SHALL include `budget: today <x> / <cap> (UTC)` (or `budget: today <x> (no daily cap)`), followed by `, paused` while the kill switch is set or `, reached` once the cap is exceeded.
5. `SEANCE_MAX_AGENT_CHANNELS` (default 2) SHALL cap the channels with an open agent Session. `SEANCE_MAX_CONTAINERS` (default 6) SHALL cap open agent sessions (channel and private), which are containers in podman mode. An invite past a cap SHALL be refused with a NOTICE to the inviter.

### Requirement 6: Kiro token exfiltration

#### Acceptance Criteria

1. In podman mode, THE runner SHALL read the regular files under `SEANCE_SANDBOX_AUTH_DIR` at start (bounded in size) and collect their secret values.
2. THE runner SHALL remove every collected secret and `KIRO_API_KEY` from all agent text sent to IRC in raw, base64 (standard and URL-safe) and hex (both cases) form, including any fragment of 8 characters or more, and fragments split across adjacent lines of one Turn.
3. THE permission handler SHALL refuse tool calls whose paths or shell commands touch the auth mount (`/run/seance/auth`) or the staged Kiro login in the container's home.
4. `docs/SANDBOX.md` SHALL document the residual risk and the use of a dedicated demo Kiro account.

### Requirement 7: Client addresses behind a proxy

#### Acceptance Criteria

1. `IRCD_TRUSTED_PROXIES` SHALL list proxy IP addresses. THE WebSocket transport SHALL take the client address from `X-Forwarded-For` only when the socket peer is a Trusted_Proxy, using the right-most entry that is not a Trusted_Proxy. An invalid header SHALL fall back to the peer address.
2. `IRCD_MAX_CONNECTIONS_PER_IP` (default 5) SHALL cap live connections per client address across both transports.
3. `IRCD_MAX_PASS_FAILURES_PER_IP` (default 10) wrong `PASS` values within 10 minutes SHALL make the ircd refuse further connections from that address until the window passes.

### Requirement 8: Public start-up guard

#### Acceptance Criteria

1. WITH `IRCD_PUBLIC=1`, THE ircd SHALL refuse to start unless all of these hold:
   - `IRCD_SERVER_PASSWORD` has at least 20 characters.
   - `IRCD_ACCOUNTS_FILE` is set and holds at least one account.
   - `IRCD_WS_ALLOWED_ORIGINS` is non-empty, has no `*` and lists only `https` origins.
   - `IRCD_HOST` is a loopback address.
   - With `SEANCE_RUNNER=1`: `SEANCE_INVITERS` is set, `SEANCE_DAILY_CREDIT_CAP` is set, and the existing podman sandbox requirements hold.
2. THE refusal SHALL list every failing variable in one message, never its value.
3. THE runner SHALL repeat its part of the check in `start()`.

### Requirement 9: Bounded host git

#### Acceptance Criteria

1. Every git call of the runner SHALL have a timeout (`SEANCE_GIT_TIMEOUT_MS`, default 60000). A timed-out call SHALL be killed and rejected, so the per-repository mutex is always released.
2. Before a host commit, THE runner SHALL measure the worktree (without `.git`). IF it exceeds `SEANCE_WORKTREE_MAX_BYTES` (default 500 MiB), or a git call of the commit times out, THEN THE runner SHALL reset the Turn's changes to the last commit and notify the ops.

### Requirement 10: Quality

#### Acceptance Criteria

1. Property tests SHALL cover nick reservation and redaction.
2. No existing test SHALL be deleted or weakened. The real `kiro-cli` SHALL NOT be used; integration tests use the fake agent.
3. The word that names the trademarked client SHALL appear nowhere.

## Follow-up requirements (review of 2026-11-08)

### Requirement 11: Trusted proxies on a public server

#### Acceptance Criteria

1. WITH `IRCD_PUBLIC=1`, THE ircd SHALL refuse to start unless `IRCD_TRUSTED_PROXIES` is non-empty and lists loopback IP addresses only (`127.0.0.0/8`, `::1`, `::ffff:127.x.y.z`). The error SHALL name the variable together with every other missing item.
2. THE runner's `start()` SHALL repeat this check when it runs as a public deployment.

### Requirement 12: Private sessions and the budget

#### Acceptance Criteria

1. Credits metered by a Private_Session SHALL count towards the daily budget (`SEANCE_DAILY_CREDIT_CAP`) and SHALL NOT change any channel total, channel cap or WHOIS channel line.
2. WHEN the daily cap is crossed, a prompting Private_Session SHALL be cancelled like a channel Session.
3. A Private_Session, and the revival of a channel Session after a process exit, SHALL each count against `SEANCE_MAX_CONTAINERS` and SHALL be refused when it is reached.

### Requirement 13: Commands during an account login

#### Acceptance Criteria

1. WHILE an account `PASS` is being verified, or the account is logged in but not yet registered, a command that needs registration SHALL be held (at most 20 lines) and replayed in order after `001`. A line past the limit SHALL get `451`.
2. IF the login fails, THEN each held line SHALL get `451`.

### Requirement 14: Worktree size during a Turn

#### Acceptance Criteria

1. WHEN a tool call of a channel Turn finishes (`tool_call_update` with status `completed` or `failed`), THE runner SHALL measure the worktree. IF it exceeds `SEANCE_WORKTREE_MAX_BYTES`, THEN THE runner SHALL cancel the Turn, notify the ops, and reset the worktree once the Turn ended.
2. Every reset for size or a git timeout SHALL also remove ignored files (`git clean -fdx`).
3. `docs/DEPLOY.md` SHALL state that a disk quota on `SEANCE_WORKSPACES` is still needed.

### Requirement 15: Honest sandbox documentation

#### Acceptance Criteria

1. `docs/SANDBOX.md` SHALL state that the Kiro login is readable inside the sandbox and egress allows uploads, so a prompt-injected `+o` agent can exfiltrate it, and that the mitigation is a dedicated demo account with low limits, revoked after judging.
2. It SHALL list the known redactor bypasses: reversed, base32, URL-encoding, zero-width characters, fragments under 8 characters.

### Requirement 16: Credits file robustness

#### Acceptance Criteria

1. THE temp file SHALL be fsynced before the rename.
2. Daily-state writes SHALL be coalesced with the ledger's flush instead of one write per metering entry.
3. An unusable session record or daily state in the file SHALL be logged, not dropped silently.
