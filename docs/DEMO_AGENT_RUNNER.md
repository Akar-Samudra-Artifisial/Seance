# Demo: Agent Runner (Journeys A and B)

A manual checklist for driving the Séance agent runner from a classic IRC client
(irssi) against the ircd. It reproduces `DESIGN.md` §2 Journey A (fixing a bug)
and Journey B (stopping scope creep). Every step lists the exact command to type
and the output lines to expect.

The runner lives in `apps/runner` (`@seance/runner`) and runs inside the ircd
process when `SEANCE_RUNNER=1`. Agents are in-process virtual clients, so there
is no second IRC server to start. See `README.md` ("Runner configuration") for
the full list of environment variables.

## 1. Prerequisites

- Node.js from `.nvmrc`, `pnpm`, and a built workspace (`pnpm install && pnpm build`).
- `irssi` installed locally.
- `kiro-cli` on the `PATH` and logged in (`kiro-cli` reads your existing login),
  or a `KIRO_API_KEY` exported in the environment. The runner never reads the key
  from a file or flag; it only passes it to the agent child process.
- A target git repository to work in. Agents never touch this repository directly;
  each channel gets its own git worktree carved out of it.

The three invitable agents (`coder`, `reviewer`, `researcher`) are loaded from the
committed `agents/` directory at the repository root. No extra setup is needed for
them.

## 2. Start the ircd with the runner enabled

Pick a target repository and a workspaces directory, then start the server. The
runner validates every variable once, in `runner.start()`, before it spawns any
process, runs git, or touches a file. An invalid value stops startup with an error
that names the variable.

```sh
IRCD_HOST=127.0.0.1 \
SEANCE_RUNNER=1 \
SEANCE_HARNESS=acp \
SEANCE_TARGET_REPO=/absolute/path/to/your/target-repo \
SEANCE_WORKSPACES="$PWD/workspaces" \
pnpm --filter @seance/ircd dev
```

Environment variables used above:

| Variable | Value here | Notes |
| --- | --- | --- |
| `IRCD_HOST` | `127.0.0.1` | Bind address. Loopback lets the demo run without `SEANCE_INVITERS`. |
| `SEANCE_RUNNER` | `1` | Enables the runner inside the ircd process. Anything else leaves it off. |
| `SEANCE_HARNESS` | `acp` | Primary harness (`kiro-cli acp`). `headless` is the fallback. Default is `acp`. |
| `SEANCE_TARGET_REPO` | your repo | Must be an existing directory and a git repository. Required. |
| `SEANCE_WORKSPACES` | `./workspaces` | Worktree root. Created if missing; its real path becomes the root. Required. |

Optional variables you may want for the demo:

- `KIRO_API_KEY` — only if you are not relying on an existing `kiro-cli` login.
- `SEANCE_CHANNEL_CREDIT_CAP` — a positive number to cap per-channel credits.
- `SEANCE_INVITERS` — comma-separated nicks allowed to invite agents and to open private
  `/msg` sessions (max 1 per human, 4 in total). When unset, anyone may, so the runner
  refuses to start unless the ircd binds to loopback: run the demo with
  `IRCD_HOST=127.0.0.1`, or set `SEANCE_INVITERS=<your nick>`. Startup otherwise fails
  with a `ConfigError` naming `SEANCE_INVITERS`.
- `SEANCE_PROMPT_TIMEOUT_MS` — hung-agent timeout, default `120000`.

The ircd listens on TCP `6667` by default (see `IRCD_TCP_PORT`).

Expected: the process stays running and logs that the runner started. It reports
startup errors (naming the variable) if a path is missing or `SEANCE_TARGET_REPO`
is not a git repository.

## 3. Connect with irssi

In another terminal:

```sh
irssi
```

Then inside irssi:

```
/connect localhost 6667
/nick op
```

Expected: the welcome numerics `001` through `005`, then the MOTD
(`375`, `372`, `376`). You are now registered as `op`.

> The demo uses the nick `op` for the human operator. The commands below assume it.

## 4. Journey A — Fixing a bug in `#fix-bug-123`

### A1. Join the channel

```
/join #fix-bug-123
```

Expected: a `JOIN` line for yourself, the names reply `353 RPL_NAMREPLY`
(you are listed as `@op`, the channel creator), and `366 RPL_ENDOFNAMES`.

### A2. Set the topic

```
/topic #fix-bug-123 Fix NPE on login when email is null
```

Expected: a `TOPIC` line echoed to the channel:

```
:op!...@... TOPIC #fix-bug-123 :Fix NPE on login when email is null
```

The topic becomes part of the summary sent to an agent when it first joins.

### A3. Invite the two agents

```
/invite coder #fix-bug-123
/invite reviewer #fix-bug-123
```

Expected for each invite:

- `341 RPL_INVITING` back to you, e.g. `:seance.local 341 op coder #fix-bug-123`.
- Shortly after, the agent's own `JOIN` line in the channel, e.g.
  `:coder!...@... JOIN #fix-bug-123`.

Behind the scenes the runner creates each agent's virtual client, joins the
channel, creates the channel worktree under `SEANCE_WORKSPACES`, and opens an ACP
session with its cwd set to that worktree.

Note: an agent joins with **no mode**. It can neither speak nor write until you
grant `+v` or `+o`. So at this point `coder` and `reviewer` are listen-only.

### A4. Voice the coder so it can speak

```
/mode #fix-bug-123 +v coder
```

Expected: a `MODE` line, e.g. `:op!...@... MODE #fix-bug-123 +v coder`.

Now channel messages reach `coder` as prompts, and `coder` can post `PRIVMSG`
lines back. As a voiced agent it can read and talk but cannot write files.

Send a message so the coder starts working:

```
plan the fix for the null email NPE
```

Expected: `coder` replies in the channel, sentence by sentence, in its profile
color. While it uses a tool, you may see a `NOTICE` describing the tool call and
its `WHOIS` status flip to `prompting`.

### A5. Promote the coder to operator so it may write

```
/mode #fix-bug-123 +o coder
```

Expected: `:op!...@... MODE #fix-bug-123 +o coder`.

As a channel operator (`+o`) the agent may now write files, run shell commands and
commit — but only inside the channel's worktree, and never to protected paths
(`AGENTS.md`, anything under `.kiro/`). The `reviewer` stays voice-only, so it can
comment but a write or shell permission request from it is rejected.

### A6. See what an agent is and what it has cost

```
/whois coder
```

Expected extra `WHOIS` lines (numeric `320`), for example:

```
model: <model>
tools: <tool summary>
status: idle
credits: #fix-bug-123 0.00 / total 0.00
```

`status` reflects the live session (`prompting`, `cooldown`, `away`, or `idle`);
credits show the per-channel amount and the agent total, each to two decimals.

### A7. (Optional) Watch the coder report a diff

When `coder` finishes a change it can post a link with `/notice`. Expect a
`NOTICE` line from `coder` in the channel. Nothing an agent emits is ever executed
as an IRC command, even if it starts with `/`.

## 5. Journey B — Stopping scope creep

The coder has started wandering outside the task. Stop it hard, then bring it back
clean.

### B1. Kick the coder

```
/kick #fix-bug-123 coder scope creep
```

Expected:

- A `KICK` line, e.g. `:op!...@... KICK #fix-bug-123 coder :scope creep`.
- The runner performs an **exorcism** for `coder` in this channel: it cancels any
  in-flight turn, waits for the cooldown, resets the worktree to the last commit
  (uncommitted and untracked changes are discarded; the branch and the channel log
  are kept), and closes the session.
- `coder` disappears from the channel. (The kick already removed it, so you will
  not see a separate leave line in this case.)

If an agent leaves on its own (via `PART` or `QUIT`) the exorcism still runs and
the agent leaves with the message `*** coder has been exorcised`.

Confirm the coder is gone:

```
/names #fix-bug-123
```

Expected: `coder` is no longer listed. `reviewer` and `op` remain.

### B2. Re-invite the coder — it resumes with a summary

```
/invite coder #fix-bug-123
```

Expected:

- `341 RPL_INVITING` back to you, then `coder` re-joins (`JOIN` line).
- Because its previous session was closed, the runner starts the new session with a
  first prompt built from a summary of the last 50 channel lines (or all lines if
  fewer than 50), plus the channel topic — all wrapped as untrusted content. The
  worktree still holds the last commit (reset in B1), and the channel log survives.

The agent rejoins with no mode again, so re-grant `+v` / `+o` as in steps A4–A5 to
let it continue.

## Scripted run (before every release)

`scripts/demo-journey.py` plays Journeys A and B as `op` against real `kiro-cli` and
exits non-zero unless all 11 checks pass (join, silent without a mode, `+o` fix + test +
commit with no permission denied, WHOIS 320 lines, kick, resume). Costs ~0.3 credits.
Run `python3 scripts/demo-journey.py --help` for the three steps (make target repo,
start the ircd on loopback, run with a fresh `--channel`).

## 6. Cleanup

- Part the channel in irssi: `/part #fix-bug-123`, then `/quit`.
- Stop the ircd process (Ctrl-C). On `SIGTERM` the runner cancels in-flight turns,
  waits for cooldowns, terminates agent processes, and disconnects the agents. It
  leaves every worktree unmodified, so uncommitted work survives a restart.
- Worktrees remain under `SEANCE_WORKSPACES`. Remove that directory if you want a
  clean slate before the next run.

## 7. Troubleshooting

- **Startup fails naming a variable** — fix that environment variable.
  `SEANCE_TARGET_REPO` must be an existing git repository; `SEANCE_WORKSPACES` must
  be a writable path.
- **`/invite coder` gets `401 ERR_NOSUCHNICK`** — the nick is not a known agent, the
  pair is banned for this channel, or `SEANCE_INVITERS` is set and your nick is not
  on the allow-list.
- **Agent joins but never speaks** — it has no mode. Grant `+v` (speak) or `+o`
  (speak and write).
- **A `+o` agent's write is refused** — the path is outside the worktree or is a
  protected path (`AGENTS.md`, anything under `.kiro/`); these are always rejected.
- **No agent output appears** — check the ircd logs for session or spawn errors;
  confirm `kiro-cli` is on the `PATH` and logged in, or that `KIRO_API_KEY` is set.
