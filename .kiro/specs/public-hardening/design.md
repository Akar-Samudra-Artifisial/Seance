# Design Document: public-hardening

## Overview

Nine findings from a security review, fixed in the ircd (`apps/ircd`) and the runner (`apps/runner`). The IRC wire protocol does not change: standard numerics only (`432`, `433`, `464`), plus one new WHOIS `320` text line (`budget:`).

| Finding | Fix | Where |
|---|---|---|
| 1 Nick squatting before auth | Hold `NICK`/`USER` until `PASS`; claim at registration; 15 s timeout; 3 strikes | `handlers/registration.ts`, `limits.ts` |
| 2 Inviters by nick only | Accounts file, scrypt, reserved nicks, `accountOf` on the host port | `accounts.ts`, `runner-wiring.ts`, `invite/allow-list.ts`, `tools/seance-account.mjs` |
| 3 `!reset-credits` for any op | Op **and** Inviter | `credits/reset-command.ts` |
| 4 Prompt gating | `+v`/`+o` sender or the agent's inviter | `session/session-manager.ts` |
| 5 Credits | File store, daily cap, kill switch, `budget:` line, channel and container caps | `credits/credits-file.ts`, `credits/budget.ts`, `ledger.ts`, `invite-controller.ts` |
| 6 Token exfiltration | Secrets from the auth dir, variant and fragment redaction, path refusal | `output/secret-redactor.ts`, `sandbox/auth-secrets.ts`, `permissions/*` |
| 7 Peers behind Caddy | Trusted proxies, `X-Forwarded-For`, per-IP caps | `client-ip.ts`, `ws-transport.ts`, `limits.ts` |
| 8 Public guard | One check that lists every failing variable | `public-guard.ts`, `sandbox/guard.ts` |
| 9 Host git | Per-call timeout, worktree size cap, reset on failure | `worktree/git.ts`, `worktree/turn-committer.ts` |

## Architecture

```mermaid
sequenceDiagram
    autonumber
    participant C as client (behind Caddy)
    participant W as WsTransport
    participant R as registration
    participant A as Accounts
    participant H as IrcHost (runner port)
    participant N as runner
    C->>W: upgrade (X-Forwarded-For)
    W->>W: client IP from XFF only if peer is trusted; per-IP cap
    C->>R: PASS alice:secret, NICK alice, USER ...
    R->>A: verify (async scrypt)
    A-->>R: account "alice"
    R->>R: claim nick at registration (reserved check)
    C->>R: INVITE coder #room
    R->>N: irc.invite (inviter alice)
    N->>H: accountOf("alice")
    H-->>N: "alice" (authenticated)
    N->>N: SEANCE_INVITERS has alice: start
```

### Registration state machine (Auth_Mode, network clients)

```text
unregistered --PASS ok--> authed(guest|account)
unregistered --PASS wrong--> strikes+1 (464; close at 3; per-IP count)
NICK/USER --> recorded only (pendingNick, user)
authed + pendingNick + user --> reserved check --> setNick --> registered
```

- `PASS` while a verification is pending is ignored (one at a time).
- `handleAuthPass` order (requirement 1.5a): (1) the exact server password is a Guest; (2) `<nick>:<secret>` is verified as an Account; (3) when that fails, or no accounts exist, and a server password is set and the part after the FIRST `:` equals it (`safeEqual`), the connection is a Guest; (4) otherwise a strike. Step 2 before step 3 keeps an Account whose secret equals the server password an Account. The web client prefixes a plain password with the nick, so a server password typed there arrives as `<nick>:<serverpw>`.
- With only a server password and no accounts, Auth_Mode still defers the claim. The existing 464 behaviour for a missing or wrong password is kept, so a client that sends `NICK`/`USER` without `PASS` gets `464` and the connection is closed.
- Outside Auth_Mode (local development) nothing changes: `NICK` claims at once, as today. Existing tests run in this mode.
- Virtual clients are exempt from auth: they are in-process and created only by the runner. This also fixes a latent bug: agents could not register on a password-protected server.

### Reserved nicks

`reserved(nick)` = account nick (case-mapped) or agent nick. Agent nicks come from the runner registry through a lazy `ServerOptions.reservedNicks()` callback, the same pattern as `inviteResolver`. A Guest gets `433` for an Account nick and `432` for an agent nick. An Account may use only its own nick and cannot change it.

### Accounts and inviters

The ircd keeps `ctx.accounts` (read once at start) and per-client `client.account`. `IrcHost` gains `accountsEnabled`, `accountOf(nick)` (the Account of a registered client, or undefined) and `isAccount(nick)`. `parseInviters(list, auth?)` keeps its old shape, so existing callers work. With `auth.required`, `allows(inviter)` also needs `accountOf(inviter)` to equal the inviter. At start, the runner checks that every `SEANCE_INVITERS` entry is an Account.

### Prompt gating

In `onChannelMessage`, the sender's mode is already read. A Turn starts for a session only when the sender is `+v`/`+o`, or `irc_lower(sender) === irc_lower(inviterOf(agent, channel))`. `InviteController` records the inviter through an optional `SessionManager.setInviter`. The message always goes to the channel log first, so context is not lost.

### Credits

- `CreditsFile` implements `SessionStore` and stores `{version: 1, sessions: [...], daily: {day, credits}}` in `<workspaces>/.seance-credits.json`. Writes go to `<file>.tmp-<pid>-<n>`, then `rename` (mode 0600), serialised by a promise chain. A missing file means empty; an unparseable file is refused at start with a message naming the path.
- `DailyBudget` (pure, injected clock): `add(n)` resets on a new UTC day, `reached()`, `line(paused)`. The ledger calls it in `add`. On the first crossing it cancels every prompting session (`allSessions`) and asks for the ChanServ notice in every channel with a session.
- The kill switch is checked with `existsSync` on each `enqueue` decision (cheap, no watcher).
- `isBlocked(channel)` = channel cap block, daily cap reached, or kill switch. Private sessions use the same global part (they ignored the channel cap before and still do).
- Channel and container caps are checked in `InviteController` before any work. A channel that already has an open session never counts as new.

### Redaction

`SecretRedactor` builds the variants of each secret of 8 or more characters: raw, base64, base64url (with and without padding), and hex in both cases. For each variant it indexes every 8-character window. Redacting one line marks every position covered by a known window, so any fragment of 8 or more characters becomes `[REDACTED]`. For splits across lines, the redactor keeps a whitespace-free tail of the Turn's earlier lines (up to the longest variant). When the tail plus the head of the new line contains a known window that crosses the boundary, the head is redacted. The tail resets when a Turn ends.

Residual risk, documented: fragments shorter than 8 characters, or a secret re-encoded in another way (for example reversed or ROT13), are not detected. The defence in depth is the permission refusal of the auth paths, the egress rule, and a dedicated low-privilege demo account.

### Client address

`clientIp(peer, xff, trusted)`: when `peer` is not trusted, return `peer`. Otherwise walk the `X-Forwarded-For` entries from the right, skipping trusted ones, and return the first valid IP (`net.isIP`). An invalid entry falls back to `peer`. A `PerIpGate` (shared by both transports) caps live connections per address. A `PassFailures` window (10 min) counts wrong `PASS` values per address and refuses new connections while the count is at the limit.

### Public guard

`checkPublicStartup(env)` collects problems into a list and throws one `PublicConfigError` naming every variable. The accounts file is read for the count (same parser as the server). The runner's `assertPublicRunner` repeats the runner-side checks (`SEANCE_INVITERS`, `SEANCE_DAILY_CREDIT_CAP`, sandbox).

### Git

`runGit(args, env, timeoutMs)` passes `timeout` and `killSignal: "SIGKILL"` to `execFile`. A timeout becomes `GitError` with `timedOut: true`. Every call through `createGitRunner` uses the configured timeout, so a `locked` section always settles. `commitTurn` first sums the file sizes of the worktree (stopping early past the cap, skipping `.git`). Past the cap, or on a timed-out call, it runs `git reset --hard` and `git clean -fd` on the worktree. The result is `kind: "reset"`, which the committer reports to the ops.

## Components and Interfaces

```ts
// apps/ircd/src/accounts.ts
export interface Accounts { has(nick: string): boolean; verify(nick: string, secret: string): Promise<boolean>; readonly size: number }
export function loadAccounts(path: string): Accounts;              // throws AccountsFileError
export function hashSecret(secret: string, opts?: ScryptOpts): string;  // used by tools/seance-account.mjs and tests
// apps/ircd/src/client-ip.ts
export function clientIp(peer: string | undefined, xff: string | undefined, trusted: ReadonlySet<string>): string | undefined;
// apps/runner/src/ports.ts (IrcHost additions)
readonly accountsEnabled?: boolean; accountOf?(nick: string): string | undefined; isAccount?(nick: string): boolean;
// apps/runner/src/output/secret-redactor.ts
export class SecretRedactor { constructor(secrets: readonly string[]); line(text: string, turnKey?: string): string; endTurn(turnKey: string): void }
// apps/runner/src/credits/budget.ts
export class DailyBudget { add(n: number): boolean /* crossed now */; reached(): boolean; today(): number; line(paused: boolean): string }
```

The new `IrcHost` members are optional, so test hosts and other embedders keep compiling. A missing `accountsEnabled` means no accounts.

## Data Models

```text
# IRCD_ACCOUNTS_FILE (mode 0600)
alice:scrypt$16384$8$1$<salt b64>$<key b64>
```

```json
{ "version": 1, "sessions": [{ "agent": "coder", "channel": "#dev", "creditsUsed": 1.75, "status": "closed", "updatedAt": 0 }], "daily": { "day": "2026-11-09", "credits": 1.75 } }
```

| Variable | Default | Meaning |
|---|---|---|
| `IRCD_ACCOUNTS_FILE` | unset | Accounts; enables Auth_Mode with or without a server password |
| `IRCD_TRUSTED_PROXIES` | empty | Comma-separated IPs whose `X-Forwarded-For` is believed |
| `IRCD_MAX_CONNECTIONS_PER_IP` | 5 | Live connections per client address |
| `IRCD_MAX_PASS_FAILURES_PER_IP` | 10 | Wrong `PASS` per address per 10 min before refusal |
| `IRCD_REGISTRATION_TIMEOUT_MS` | 15000 (was 60000) | Time to register |
| `SEANCE_DAILY_CREDIT_CAP` | unset | Credits per UTC day, all agents |
| `SEANCE_KILL_SWITCH_FILE` | `<workspaces>/.seance-paused` | Exists = no new Turns |
| `SEANCE_MAX_AGENT_CHANNELS` | 2 | Channels with an open agent Session |
| `SEANCE_MAX_CONTAINERS` | 6 | Open agent sessions (containers in podman mode) |
| `SEANCE_GIT_TIMEOUT_MS` | 60000 | Per git call |
| `SEANCE_WORKTREE_MAX_BYTES` | 524288000 | Worktree size before a host commit |

## Correctness Properties

### Property 1: Reserved nicks stay reserved

For any sequence of registrations and `NICK` commands by Guests, Accounts and virtual clients, with arbitrary case variants under rfc1459: no Guest ever holds an Account nick or an agent nick, an Account holds only its own nick, and no nick is claimed before registration completes.

**Validates: Requirements 1.1, 1.5, 2.3, 2.4, 2.5**

### Property 2: Redaction removes every variant and fragment

For any secret of 8 to 64 characters, any variant (raw, base64, base64url, hex), and any text that embeds a fragment of 8 or more characters of it, alone or split across two adjacent lines of one Turn: the output contains no 8-character window of any variant. Text without secret material is unchanged.

**Validates: Requirements 6.2**

### Property 3: Client IP

For any peer, trusted set and `X-Forwarded-For` value: the result is the peer when the peer is not trusted; otherwise it is a valid IP from the header that is not trusted, or the peer.

**Validates: Requirements 7.1**

## Error Handling

- An accounts file that is unsafe or invalid, an unparseable credits file, or an invalid variable: the start fails with a message naming the variable or file and never the secret.
- A scrypt error during `PASS` counts as a wrong `PASS`.
- A credits file write that fails is logged, and the record stays dirty (existing behaviour).
- A daily-cap ChanServ notice that fails is logged; the block still applies.
- A git timeout: logged, the worktree is reset, the ops are told, and the mutex is released.

## Testing Strategy

- ircd unit: registration in Auth_Mode (hold, claim, timeout default, strikes, guests, accounts, reserved nicks, virtual exemption), accounts file parsing and permissions, `clientIp`, per-IP gate and failure window, the public guard listing every variable.
- Runner unit: allow-list with auth, `!reset-credits` with an Inviter, prompt gating, `CreditsFile` round trip and atomic write, `DailyBudget` day roll-over, kill switch, WHOIS `budget:`, channel and container caps, `SecretRedactor`, auth path refusal, git timeout and size cap.
- Properties P1 to P3 with fast-check.
- Integration (fake agent): an inviter without an account is refused; the daily cap notice; the budget line in WHOIS.
- Existing ircd tests keep running outside Auth_Mode and keep passing unchanged. Tests that relied on an unmoded human prompting agents (Requirement 4) or on a public start with the sandbox alone (Requirement 8) change on purpose, each with a comment naming the requirement.

## Follow-up design (Requirements 11 to 16)

- **Trusted proxies (11).** `publicHardeningProblems` adds `IRCD_TRUSTED_PROXIES` (non-empty, every entry an IP literal in `127.0.0.0/8`, `::1` or `::ffff:127.x`). `RunnerOptions.trustedProxies` carries the parsed list into `assertPublicRunner`.
- **Private credits (12).** `CreditLedger.recordPrivateMetering(acc, entries)` feeds only `#addDaily`. `SessionManager` keeps opened Private_Sessions in a set; `allSessions()` returns channel and private Sessions for the daily-cap cancel. The runner's `containersFull(pendingStarts)` counts open channel Sessions, starts in flight (`InviteController.pendingStarts()`), revivals in flight and Private_Sessions; it gates invites, `privateCapacity` and `reviveSession`.
- **Held lines (13).** The router asks `holdUntilLoggedIn(client, msg, replay)` before replying `451`. Lines are kept in the client's auth state while it is `pending` or `account` and unregistered; `releaseHeld` replays them through the router after `001`, or answers `451` after a failed login.
- **Size during a Turn (14).** The ACP harness emits `tool-done` for a `tool_call_update` with status `completed` or `failed`. `buildChannelSession` checks `WorktreeManager.exceedsCap` (one check at a time); over the cap it cancels the prompting Turn and, in a `turnEnding` hook, runs `reset(channel, { ignored: true })`.
- **Credits file (16).** `open` + `writeFile` + `sync` + `close`, then `rename`. The ledger marks the daily state dirty and writes it in `#writeDirty`. The constructor takes `onSkip(what, reason)`.

## Open Points

1. **Agent nick reservation timing.** Agent nicks come from the runner registry, which loads before the listeners open, so there is no window in which a Guest could take one.
2. **Fragment length.** 8 characters is the shortest fragment that is redacted. Shorter fragments can leak; documented as residual risk.
3. **TCP and proxies.** Plain TCP (6667) has no proxy header. The public guard requires `IRCD_HOST` loopback, so TCP is not exposed in the public deployment.
