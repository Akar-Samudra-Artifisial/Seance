# Requirements Document

## Introduction

`agent-runner` is the M2 milestone of Séance: the library in `apps/runner` (`@seance/runner`) that turns Kiro agents into IRC users (`DESIGN.md` §2 Journeys A–C, §3, §4 "Message flow", §5, §6). The runner is started in the same Node process as the ircd; `apps/ircd/src/index.ts` wires it in when `SEANCE_RUNNER=1`. Each agent is an ircd `VirtualClient`, so there is no network hop and no second source of IRC state. Redis is not used in this milestone.

The runner drives `kiro-cli acp --agent <name>` over newline-delimited JSON-RPC on stdio (one process per agent, one ACP session per channel), with a `kiro-cli chat --no-interactive` fallback behind the same `AgentHarness` interface. The JSON-RPC client is promoted from `spikes/acp/src/acp-client.ts` into `apps/runner/src/acp/`; `@agentclientprotocol/sdk` is not used. Each channel gets a git worktree sandbox. IRC modes act as permissions: `+o` may write, `+v` may speak, no mode is listen-only, and only messages from human channel operators become instructions. Everything else reaches an agent wrapped in `<untrusted>`.

The runner builds on `ircd-core` (`VirtualClient`, `EventBus` events `irc.message`, `irc.mode`, `irc.kick`) and `ircd-agent-commands` (`InviteResolver`, the `irc.invite` event, `whoisExtra`, `AWAY`). Session persistence sits behind a `SessionStore` interface with an in-memory implementation only; a Postgres implementation in `packages/db` comes later.

Correctness properties P1–P6 are stated in the requirements that govern them and are formalised in the design phase (fast-check, at least 100 runs, tagged `Feature: agent-runner`).

Non-requirement deliverables, tracked as tasks: a README section for the runner environment variables (including `SEANCE_INVITE_RATE` and `SEANCE_INVITERS`), the wiring in `apps/ircd/src/index.ts`, a manual demo checklist for Journeys A and B with irssi, and a final checkpoint of `pnpm typecheck && pnpm test`.

## Glossary

- **Runner:** the library in `apps/runner` (`@seance/runner`); the system under test and the subject of every requirement unless another system is named.
- **IRCd:** the server in `apps/ircd`, running in the same process as the Runner.
- **Agent:** a Kiro-backed participant registered in the Agent_Registry and presented to IRC as a virtual client.
- **Agent_Profile:** the runtime description of one Agent: nick, Kiro agent name, model, tool summary and IRC color.
- **Agent_Registry:** the component that loads and serves Agent_Profiles.
- **Dev_Agent:** a development agent under `.kiro/agents` (`seance-dev`, `seance-reviewer`, `seance-spec`); never an Agent.
- **Human_Op:** a channel member with `+o` who is not an Agent.
- **Channel_Op_Agent:** an Agent with `+o` in a channel.
- **Voiced_Agent:** an Agent with `+v` and without `+o` in a channel.
- **AgentHarness:** the interface through which the Runner starts agent processes, opens sessions, sends prompts, cancels turns and receives events.
- **AcpHarness:** the primary AgentHarness; one `kiro-cli acp --agent <name>` process per Agent.
- **HeadlessHarness:** the fallback AgentHarness; one `kiro-cli chat --no-interactive` invocation per prompt.
- **ACP:** the Agent Client Protocol, JSON-RPC 2.0 over newline-delimited stdio.
- **Acp_Client:** the dependency-free JSON-RPC client in `apps/runner/src/acp/`, promoted from the spike.
- **Session:** the pair (Agent, channel) together with its ACP session id, state, queue and credits.
- **Private_Session:** a Session for the pair (Agent, human nick) created by a private message.
- **Session_State:** one of `idle`, `prompting`, `cancelling`, `cooldown`, `closed`.
- **Turn:** one `session/prompt` request and its response.
- **In_Flight_Prompt:** a Turn that has been sent and has not yet resolved.
- **Cooldown:** the interval after a cancelled Turn ends when the Runner waits for `_kiro.dev/metadata.turnDurationMs` or for 1 second, whichever comes first.
- **Prompt_Queue:** the bounded FIFO of prompts waiting for a Session to become `idle`; its bound is 20 entries.
- **Untrusted_Wrapper:** the text `<untrusted>` … `</untrusted>` placed around content that is not an instruction.
- **Worktree:** the git worktree of a channel at `SEANCE_WORKSPACES/<sanitized-channel>` on branch `seance/<channel>`, created from `SEANCE_TARGET_REPO`.
- **Worktree_Root:** the directory named by `SEANCE_WORKSPACES`.
- **Sanitized_Channel:** a channel name mapped to a single safe path segment.
- **Permission_Policy:** the pure function from (channel mode, tool kind, path or command) to a permission decision.
- **Permission_Decision:** one of `allow_once`, `reject_once`.
- **Sentence_Buffer:** the component that buffers `agent_message_chunk` text and emits it as IRC lines.
- **Idle_Flush:** emission of buffered text after 1.5 seconds without a new chunk.
- **Line_Limit:** 512 bytes including CRLF, measured in UTF-8 bytes.
- **Agent_Color:** the `^K` (0x03) color code of an Agent_Profile.
- **Hung_Agent:** an agent process from which no frame arrived for `SEANCE_PROMPT_TIMEOUT_MS` (default 120000) while a Turn was in flight.
- **Exorcism:** the sequence of actions the Runner takes when an Agent is removed from a channel: cancel, Cooldown, worktree reset, session close and leave.
- **Ban_List:** the set of (channel, agent nick) pairs for which invitations are refused.
- **Inviter_Allow_List:** the optional set of inviter nicks named by `SEANCE_INVITERS` (comma-separated, compared with rfc1459 case-mapping via `irc_lower`); when unset or empty after trimming, every inviter is allowed.
- **Invite_Rate_Limit:** the maximum number of counted invitations per inviter in any sliding window of 60 seconds, named by `SEANCE_INVITE_RATE` (default 5); the inviter key is `irc_lower(inviter)`.
- **Invite_Key:** the pair (`targetKey`, `irc_lower(channel)`) identifying one Agent and one channel; `targetKey` is the field of the `irc.invite` event holding `irc_lower(target)`.
- **Invite_Dedup_State:** the set of Invite_Keys for which a Session exists in a state other than `closed` or is being created.
- **Whois_Snapshot:** the in-memory per-Agent record (model, tool summary, per-channel Session_State and credits, AWAY text) maintained by the Runner and read by `whoisExtra`.
- **Credit:** one unit reported in `_kiro.dev/metadata.meteringUsage[].value` with unit `credit`.
- **Credit_Cap:** the optional per-channel limit `SEANCE_CHANNEL_CREDIT_CAP` on Credits summed over all Agents.
- **SessionStore:** the persistence interface for Session records; in this milestone only an in-memory implementation exists.
- **Fake_Agent:** the scriptable ACP agent under `apps/runner/test/fixtures` used by every automated test.
- **Redaction:** replacement of secret-looking values by `[REDACTED]` with the spike's `redact()`.

---

## Requirements
### Requirement 1: Agent registry

**User Story:** As an operator, I want three runtime agents (coder, reviewer, researcher) defined in files, so that I can invite them by nick and see what each one is.

#### Acceptance Criteria

1. WHEN the Runner starts, THE Agent_Registry SHALL load one Agent_Profile from each file matching `agents/<name>.json` in the repository root (Crew App layout, `DESIGN.md` §5) and SHALL complete loading of all files before the Runner accepts its first invite.
2. THE Agent_Profile SHALL contain a nick of 1 to 30 characters, a Kiro agent name of 1 to 64 characters, a model of 1 to 64 characters, a tool summary of 1 to 256 characters and an IRC color as an integer from 0 to 15 inclusive.
3. THE Agent_Registry SHALL provide exactly the profiles `coder`, `reviewer` and `researcher` from the files committed in the repository `agents/` directory.
4. WHEN a nick is looked up, THE Agent_Registry SHALL compare it using rfc1459 case-mapping and SHALL return the matching Agent_Profile, or a not-found result if no profile matches.
5. THE Agent_Registry SHALL load profiles only from `agents/`, never from `.kiro/agents`, so that Dev_Agents are never invitable.
6. IF an `agents/<name>.json` file is not valid JSON, lacks a required field, has a field of the wrong type or length, has a color outside 0 to 15, or has a nick that is not a valid IRC nick, THEN THE Agent_Registry SHALL reject that file with an error naming the file and the failing field, SHALL NOT register a profile from it, and SHALL continue loading the other files.
7. IF two profiles have nicks that are equal under rfc1459 case-mapping, THEN THE Agent_Registry SHALL reject the second profile, in ascending filename order, with an error naming both files and SHALL keep the first profile registered.
8. IF the Agent_Registry loads no valid profile, THEN THE Runner SHALL fail to start with an error stating that no agent profile is available and SHALL exit with a non-zero exit code.
9. THE Runner SHALL complete Task 0 before any other task: spike S8, which verifies how `kiro-cli acp --agent <name>` resolves agent files when the process cwd differs from the session cwd, and spike S9, which verifies whether `.kiro/steering` and `.kiro/hooks` inside the session cwd are loaded by `kiro-cli acp`; THE Runner SHALL record both answers in `spikes/acp/FINDINGS.md`.
10. THE Runner SHALL, regardless of the Task 0 spike result, spawn each agent process with its process cwd set to the directory containing the agent definitions and SHALL pass the channel Worktree only as the ACP session cwd; the spike result is recorded in `spikes/acp/FINDINGS.md` for documentation and does not change the spawn strategy.
11. WHEN the Runner starts, THE Runner SHALL verify, for every registered Agent_Profile, that the file `<agents directory>/.kiro/agents/<kiro agent name>.json` exists and is a regular file, before it accepts its first invite and before it spawns any agent process; IF any such file is missing, THEN THE Runner SHALL fail to start with an error naming the Agent_Profile file, the Kiro agent name and the expected path, and SHALL exit with a non-zero exit code (fail closed on agent resolution, spike S8: a missing agent file silently falls back to `kiro_default`).

### Requirement 2: Agent harness and authentication

**User Story:** As an operator, I want one harness interface with a primary and a fallback implementation, so that agents keep working if ACP does not.

#### Acceptance Criteria

1. THE Runner SHALL define an `AgentHarness` interface with operations to open a session in a given cwd, send a prompt, cancel a prompt, close a session, terminate the agent process, and subscribe to streamed events.
2. WHEN the first session request for an Agent arrives and no process exists for that Agent, THE AcpHarness SHALL spawn exactly one `kiro-cli acp --agent <kiro agent name>` process for that Agent.
3. WHEN a session is requested for a channel, THE AcpHarness SHALL open exactly one ACP session for that channel in the Agent's existing process and SHALL NOT spawn a second process for the same Agent.
4. THE AcpHarness SHALL spawn agent processes without the `--trust-all-tools` argument.
5. WHERE `SEANCE_HARNESS` is `headless`, THE Runner SHALL use the HeadlessHarness, which runs `kiro-cli chat --agent <kiro agent name> --no-interactive` once per prompt with cwd set to the channel Worktree.
6. WHEN `SEANCE_HARNESS` is unset, empty or `acp`, THE Runner SHALL use the AcpHarness.
7. IF `SEANCE_HARNESS` has any value other than unset, empty, `acp` or `headless`, THEN THE Runner SHALL exit during startup with a non-zero exit code and an error message naming `SEANCE_HARNESS` and the accepted values `acp` and `headless`, before spawning any agent process.
8. WHEN `KIRO_API_KEY` is set and non-empty in the environment, THE Runner SHALL pass it to each agent process through the process environment and through no command-line argument.
9. WHEN `KIRO_API_KEY` is not set or is empty, THE Runner SHALL spawn agent processes without a `KIRO_API_KEY` entry and SHALL rely on the existing `kiro-cli` login.
10. THE Runner SHALL apply Redaction to every logged frame, command line and error message so that the value of `KIRO_API_KEY` and the values of secret-looking JSON fields never appear in a log.
11. WHEN the Acp_Client receives a frame, THE Acp_Client SHALL validate the frame shape at the boundary, accept a request id that is a number or a string, and ignore unknown `_kiro.dev/*` notifications without logging an error.
12. IF the Acp_Client receives a frame that fails shape validation, THEN THE Acp_Client SHALL discard the frame, log one error stating the validation failure with the frame Redacted, and keep the process running and its sessions open.
13. IF `kiro-cli` cannot be spawned or exits before the `initialize` response arrives, THEN THE Runner SHALL reject each pending session request for that Agent with an error stating the command, the exit code or signal, and the last stderr line, and SHALL spawn a new process on the next session request for that Agent.
14. THE Acp_Client SHALL be implemented in `apps/runner/src/acp/` without a new runtime dependency.
15. WHEN a `session/new` response arrives for an Agent, THE AcpHarness SHALL compare `modes.currentModeId` with the Kiro agent name of the Agent_Profile before the session is returned to the Runner; the session SHALL be usable only if the two are equal.
16. IF `modes.currentModeId` is absent or differs from the Kiro agent name (for example `kiro_default`), THEN THE AcpHarness SHALL close that session, send `SIGTERM` to the agent process (applying criterion 9.14 to any other sessions of that process), fail the session request with an error stating the expected and the actual mode, and SHALL send no `session/prompt` to that session; THE Runner SHALL send one `NOTICE` to the inviter with the text `agent profile <kiro agent name> not loaded` (when the session was requested by an invitation) and SHALL treat the failure as a `session/new` failure under Requirement 3, criterion 9 (or Requirement 9, criterion 16 on revival).

### Requirement 3: Invite and join

**User Story:** As an operator, I want `/invite coder` to bring the agent into my channel, so that it starts working on the channel's task.

#### Acceptance Criteria

1. THE Runner SHALL implement the ircd `InviteResolver`, a synchronous function `(target: string, channel: string, inviter: string) => boolean`, and claim (return `true` for) every nick that matches a registered Agent_Profile, using IRC case-mapping (`rfc1459`, `irc_lower`) for the comparison, is not on the Ban_List for the channel, and is permitted by the Inviter_Allow_List (criterion 14); THE InviteResolver SHALL return `false` for every other nick and SHALL perform no I/O.
2. WHEN the Runner receives an `irc.invite` event for a claimed Agent nick that passes the dedup check (criterion 13) and the Invite_Rate_Limit (criterion 16), THE Runner SHALL create the Agent's virtual client if it does not yet exist, registering through `NICK` and `USER` via the command router, and SHALL complete registration (receipt of `001 RPL_WELCOME`) within 5 seconds.
3. WHEN the virtual client is registered, THE Runner SHALL send `JOIN` for the channel through that virtual client.
4. WHEN the virtual client has joined, THE Runner SHALL create the channel Worktree if it does not exist, and then open an ACP session with `cwd` set to the Worktree path, within 30 seconds of the join.
5. WHEN an Agent joins a channel, THE Runner SHALL leave the Agent with no channel mode (neither `+v` nor `+o`), so that an operator must grant `+v` or `+o`.
6. WHEN the same Agent is invited to a channel in which it already has a Session whose state is not `closed`, THE Runner SHALL create no virtual client, Worktree or ACP session and send no `JOIN`, as specified by criterion 13.
7. WHEN an Agent is invited to a channel in which its previous Session is `closed`, THE Runner SHALL start the new session with a first prompt that contains a summary of the last 50 channel lines (or all lines if fewer than 50 exist) wrapped in an Untrusted_Wrapper.
8. WHEN the Runner builds the summary, THE Runner SHALL include the channel topic inside an Untrusted_Wrapper, and SHALL include an empty-topic marker inside the wrapper if the topic is not set.
9. IF the worktree creation or `session/new` fails, THEN THE Runner SHALL leave the channel with `PART`, send a `NOTICE` to the channel naming the failing step and the cause, keep the channel's other Sessions running, and leave no Session for that Agent and channel in a state other than `closed`.
10. WHILE two or more invitations for the same Agent and channel are being processed, THE Runner SHALL create exactly one virtual client, one Worktree and one ACP session for that pair (concurrent case of criterion 13).
11. WHEN the Runner creates a virtual client, THE Runner SHALL give it the synchronous `whoisExtra` function (`() => readonly string[]`) required by Requirement 10, backed by the Whois_Snapshot.
12. IF the Agent's nick is in use by a non-Agent client at the time of the first invitation, THEN THE Runner SHALL send a `NOTICE` to the inviter stating that the nick is unavailable, SHALL create no virtual client, Worktree or Session, and SHALL leave the existing client unaffected.
13. WHEN an `irc.invite` event arrives whose Invite_Key (`targetKey` and channel) is in the Invite_Dedup_State, THE Runner SHALL create no second virtual client, Worktree or ACP session, SHALL send no `JOIN`, SHALL send no `NOTICE`, and SHALL NOT count the event against the Invite_Rate_Limit of the inviter; THE Runner SHALL add an Invite_Key to the Invite_Dedup_State before starting any work for it and SHALL remove it when the Session reaches `closed` or creation fails.
14. WHERE `SEANCE_INVITERS` is set and non-empty after trimming, THE InviteResolver SHALL NOT claim an invite whose `inviter` argument is not in the Inviter_Allow_List (compared with `irc_lower`), so that the ircd replies `401 ERR_NOSUCHNICK` as for an unknown nick; WHERE `SEANCE_INVITERS` is unset or empty after trimming, THE InviteResolver SHALL allow any inviter.
15. THE Runner SHALL evaluate the Inviter_Allow_List in the InviteResolver before the Invite_Rate_Limit and before any Invite_Dedup_State entry is created, so that an invite that is not claimed leaves no state and does not count against any rate.
16. WHEN a claimed `irc.invite` event passes the dedup check of criterion 13 and the inviter has already had `SEANCE_INVITE_RATE` counted invitations within the preceding 60 seconds (measured by the event `ts`), THE Runner SHALL start no join, SHALL create no virtual client, Worktree, process or Invite_Dedup_State entry, and SHALL send one `NOTICE` to the inviter stating the limit and the number of seconds (rounded up) until the inviter may retry.
17. THE Runner SHALL count an invitation against the Invite_Rate_Limit of its inviter only when it passes the dedup check, and SHALL perform the Invite_Rate_Limit check before creating any virtual client, Worktree or agent process.
18. WHERE `SEANCE_INVITE_RATE` is unset or empty, THE Runner SHALL use an Invite_Rate_Limit of 5 invitations per minute per inviter.
19. IF `SEANCE_INVITE_RATE` is set to a value that is not a positive integer, THEN THE Runner SHALL fail to start with an error naming `SEANCE_INVITE_RATE` and the rejected value, before accepting any invite.
20. IF `SEANCE_INVITERS` contains an entry that is not a valid IRC nick (`isValidNick`) after trimming, THEN THE Runner SHALL fail to start with an error naming `SEANCE_INVITERS` and the rejected entry, before accepting any invite.

### Requirement 4: Channel worktrees

**User Story:** As an operator, I want each channel to have its own isolated git worktree, so that agents in one task cannot touch another task or the rest of my disk.

#### Acceptance Criteria

1. WHEN a Worktree is needed for a channel and no Worktree exists for it, THE Runner SHALL run `git worktree add` from `SEANCE_TARGET_REPO` for the path `SEANCE_WORKSPACES/<Sanitized_Channel>` on the branch `seance/<channel>`.
2. THE Runner SHALL map a channel name to a Sanitized_Channel that is a single path segment of 1 to 64 characters containing only ASCII letters, digits, `-` and `_`, and that is neither `.` nor `..`.
3. THE Runner SHALL map two channel names that are different under rfc1459 case-mapping to two different Sanitized_Channels, and SHALL map two channel names that are equal under rfc1459 case-mapping to the same Sanitized_Channel.
4. WHEN the Runner uses a Worktree path, THE Runner SHALL resolve it with `realpath` and confirm that the result is strictly inside the realpath of the Worktree_Root, before starting any agent session or file operation in it.
5. IF a resolved Worktree path is equal to or outside the Worktree_Root, THEN THE Runner SHALL refuse to use it, SHALL start no agent session in it, and SHALL report an error naming the channel.
6. IF the Worktree already exists for the channel, THEN THE Runner SHALL reuse it and create no second Worktree or branch.
7. IF `SEANCE_TARGET_REPO` or `SEANCE_WORKSPACES` is unset or empty, or `SEANCE_TARGET_REPO` is not a git repository, THEN THE Runner SHALL fail to start with an error naming the variable and SHALL create no Worktree.
8. WHEN an Exorcism resets a Worktree, THE Runner SHALL discard uncommitted changes and untracked files inside that Worktree only, returning it to the last commit, and SHALL keep the branch and the channel log.
9. IF `git worktree add` or the Exorcism reset exits with a non-zero status, THEN THE Runner SHALL report an error naming the channel and the failed git operation, and SHALL leave any existing Worktree contents and the channel log unchanged.
10. THE Runner SHALL run git commands with an argument array and not through a shell, so that channel names never reach a shell.
11. FOR ALL channel names, including names with `/`, `..`, NUL, spaces and multi-byte UTF-8, THE Runner SHALL produce a Worktree path whose realpath is strictly inside the Worktree_Root (confinement property).
12. THE Runner SHALL create each Worktree with git no-cone sparse-checkout that excludes every `AGENTS.md` (including the lower-case spelling `agents.md`) and every `.kiro/` directory of the target repository at every depth, using the patterns `!AGENTS.md`, `!agents.md`, `!.kiro/` and the nested variants `!**/AGENTS.md`, `!**/agents.md` and `!**/.kiro/`, because `kiro-cli acp` loads `AGENTS.md` and `.kiro/skills/*/SKILL.md` from the session cwd without approval (spike S9: a target repository can inject instructions).
13. WHEN the Runner creates or reuses a Worktree, THE Runner SHALL scan the whole Worktree tree (not only its root, not following symlinks, skipping only the `.git` entry) for any entry (file, directory or symlink) named `AGENTS.md` or `.kiro`, comparing names case-insensitively; IF any is found, THEN THE Runner SHALL refuse the session, send a channel `NOTICE` naming the cause and the relative paths (within the 512-byte limit), and treat it as a worktree failure under criterion 9.
14. WHEN the Runner is about to send a `session/prompt` for a Session (not only at Worktree creation or reuse), THE Runner SHALL first scan the Worktree as in criterion 13; IF an `AGENTS.md` or `.kiro` entry is found, THEN THE Runner SHALL send no `session/prompt` for that prompt, SHALL report that prompt as dropped, SHALL reset the Worktree (criterion 8) and remove the found entries, and SHALL send one `NOTICE` to the channel's Human_Ops naming the Agent and the relative paths. THE Runner SHALL NOT send `session/cancel` for this reason and SHALL NOT interrupt a Turn that is already in flight; the prompts queued behind it are checked individually before they are sent.

### Requirement 5: Message to prompt

**User Story:** As an operator, I want channel messages to reach agents as prompts while untrusted text cannot give them orders, so that a chat message cannot hijack an agent.

#### Acceptance Criteria

1. WHEN an `irc.message` event for a `PRIVMSG` to a channel arrives, THE Runner SHALL enqueue exactly one prompt for each Agent that is a member of that channel with `+v` or `+o`, except the Agent that sent the message.
2. WHEN a prompt is built from a channel message, THE Runner SHALL format it as `[#ch] <nick> text`, with `@` placed before the nick when the sender has `+o`.
3. WHEN the sender is a Human_Op, THE Runner SHALL place the text in the prompt outside any Untrusted_Wrapper.
4. WHEN the sender is not a Human_Op (another Agent, or a human without `+o`), THE Runner SHALL wrap the message text in an Untrusted_Wrapper.
5. THE Runner SHALL wrap the channel topic, tool output, history summaries and every other text not typed by a Human_Op in an Untrusted_Wrapper.
6. IF message text contains the literal text `</untrusted>` (matched case-insensitively), THEN THE Runner SHALL neutralise every occurrence so that the text inside the Untrusted_Wrapper cannot close the wrapper, and the prompt SHALL contain exactly one closing wrapper tag per Untrusted_Wrapper.
7. WHILE a channel has mode `+m`, THE Runner SHALL enqueue no prompt for an Agent that has neither `+v` nor `+o`.
8. WHILE an Agent has no mode in a channel, THE Runner SHALL enqueue no prompt for that Agent from that channel.
9. WHEN a human sends `PRIVMSG <agent nick> :text`, THE Runner SHALL enqueue the text as a prompt in the Private_Session for that human and Agent, separate from any channel Session.
10. WHEN the Runner creates a Private_Session, THE Runner SHALL open it with `cwd` set to a Worktree-Root subdirectory dedicated to that Agent, perform no channel-state write, and grant the session no write or shell permission.
11. WHEN a Private_Session prompt is built, THE Runner SHALL place the text of a Human_Op outside an Untrusted_Wrapper and the text of any other sender inside one.
12. THE Runner SHALL send a prompt to an Agent only through that Agent's Session, never as an IRC command.
13. FOR ALL sequences of channel messages with arbitrary senders, modes and text, the portion of any prompt that lies outside every Untrusted_Wrapper SHALL consist only of the Runner's fixed prompt template and text typed by Human_Ops (P3, untrusted-wrapping property).
14. IF a message to a channel or to an Agent is not a `PRIVMSG` (for example a `NOTICE`), or the target is neither a channel with a Session nor a known Agent nick, THEN THE Runner SHALL enqueue no prompt and SHALL record a log entry naming the ignored event and the reason.

### Requirement 6: Session state machine

**User Story:** As an operator, I want each agent session to process one prompt at a time and survive cancels, so that messages are never lost or interleaved and a stop never corrupts the next turn.

#### Acceptance Criteria

1. THE Runner SHALL track each Session in exactly one Session_State: `idle`, `prompting`, `cancelling`, `cooldown` or `closed`.
2. WHEN a prompt is enqueued for a Session in `idle` with an empty Prompt_Queue, THE Runner SHALL send it as a `session/prompt` and move the Session to `prompting`.
3. WHILE a Session is in `prompting`, `cancelling` or `cooldown`, THE Runner SHALL append new prompts to the Prompt_Queue and send no `session/prompt`.
4. WHEN the In_Flight_Prompt of a `prompting` Session resolves with `end_turn`, THE Runner SHALL move the Session to `idle` and, if the Prompt_Queue is not empty, send the oldest queued prompt as a `session/prompt` and move the Session to `prompting`.
5. IF the In_Flight_Prompt of a `prompting` Session fails or resolves with a stop reason other than `end_turn` or a cancellation, THEN THE Runner SHALL move the Session to `idle`, send a `NOTICE` to the channel's Human_Ops naming the Agent and the failure reason, keep the Prompt_Queue unchanged, and send the oldest queued prompt if one exists.
6. WHEN a cancel is requested for a Session in `prompting`, THE Runner SHALL send `session/cancel` exactly once and move the Session to `cancelling`.
7. IF a cancel is requested for a Session that is not in `prompting`, THEN THE Runner SHALL send no `session/cancel` and leave the Session_State and Prompt_Queue unchanged.
8. WHEN the In_Flight_Prompt of a `cancelling` Session resolves, THE Runner SHALL move the Session to `cooldown`.
9. WHEN `_kiro.dev/metadata` with `turnDurationMs` arrives for a Session in `cooldown`, or 1000 ms have elapsed since the cancelled Turn resolved, whichever is first, THE Runner SHALL move the Session to `idle` and, if the Prompt_Queue is not empty, send the oldest queued prompt and move the Session to `prompting`.
10. IF the Prompt_Queue holds 20 prompts and a new prompt arrives, THEN THE Runner SHALL drop the oldest queued prompt, append the new prompt so the queue still holds 20 prompts, and send a `NOTICE` to the channel's Human_Ops naming the Agent and the dropped message.
11. WHEN a Session is moved to `closed`, THE Runner SHALL report every prompt still in the Prompt_Queue as dropped, empty the Prompt_Queue, and cancel any pending cooldown timer.
12. WHILE a Session is in `closed`, THE Runner SHALL reject every new prompt for that Session, report it as dropped, and send no `session/prompt`.
13. WHEN a closed Session is replaced after a new invitation, THE Runner SHALL create a new Session in `idle` with an empty Prompt_Queue.
14. FOR ALL interleavings of `PRIVMSG`, `KICK`, `PART`, cancel requests and turn-end events, THE Runner SHALL hold at most one In_Flight_Prompt per Session, SHALL send `session/cancel` only while a Turn is in flight, and SHALL send no `session/prompt` while the Session is in `cancelling` or `cooldown` (P1, state-machine safety property).
15. FOR ALL sequences of enqueued prompts, THE Runner SHALL deliver each prompt exactly once, either as a `session/prompt` or as a reported drop, and SHALL preserve enqueue order among the delivered prompts of one Session (P2, exactly-once-in-order property).

### Requirement 7: Output streaming

**User Story:** As an operator, I want the agent's words to appear in the channel sentence by sentence and its tool use to be visible, so that I can see what is happening right now.

#### Acceptance Criteria

1. WHEN a `session/update` with `sessionUpdate` equal to `agent_message_chunk` arrives, THE Sentence_Buffer SHALL append the chunk text to the buffer of that Session in arrival order.
2. WHEN the buffer contains one or more complete sentences (text ending in `.`, `!`, `?` or a newline), THE Sentence_Buffer SHALL emit each complete sentence, in order, as one `PRIVMSG` to the channel from the Agent's virtual client and SHALL retain the trailing incomplete text in the buffer.
3. WHEN 1500 milliseconds pass after the last `agent_message_chunk` of a Session and the buffer holds non-whitespace text, THE Sentence_Buffer SHALL emit the buffered text as one `PRIVMSG` (Idle_Flush) and SHALL empty the buffer.
4. WHEN a Turn ends, THE Sentence_Buffer SHALL emit any remaining buffered non-whitespace text before the Runner reports the Turn as ended, and SHALL empty the buffer.
5. WHEN the Sentence_Buffer emits text, THE Runner SHALL prefix it with the Agent_Color code and suffix it with a reset code, so that the serialized line, including the `PRIVMSG` prefix, target, color codes and CRLF, is at most 512 bytes (Line_Limit).
6. IF a sentence does not fit within the Line_Limit, THEN THE Runner SHALL split it at a UTF-8 code point boundary into several `PRIVMSG` lines, each at most 512 bytes including CRLF, and SHALL emit them in original order without losing or duplicating any character.
7. THE Runner SHALL remove CR, LF and NUL characters from emitted text and SHALL emit no `PRIVMSG` whose text is empty or whitespace only.
8. THE Runner SHALL send Agent output only as `PRIVMSG` or `NOTICE` text and SHALL NOT parse, execute or route Agent output as an IRC command, including text that starts with `/` or contains `\r\n`.
9. WHEN a `session/update` with `sessionUpdate` equal to `tool_call` arrives, THE Runner SHALL set the Agent's `AWAY` to `<tool>: <path or command summary>`, truncated to AWAYLEN bytes at a UTF-8 code point boundary, and SHALL send a `NOTICE` to the channel with the same summary, truncated to the Line_Limit.
10. WHEN a Turn ends, THE Runner SHALL clear the Agent's `AWAY`.
11. IF a `session/update` has an unknown `sessionUpdate` value, THEN THE Runner SHALL ignore it, SHALL send nothing to IRC, and SHALL keep the Session running.
12. WHEN a `session/update` with `sessionUpdate` equal to `agent_thought_chunk` arrives, THE Runner SHALL send its text nowhere in IRC and SHALL NOT add it to the Sentence_Buffer.
13. FOR ALL Agent output strings, including multi-byte UTF-8 and strings with CR, LF and NUL, every line emitted by the Sentence_Buffer SHALL serialize to at most 512 bytes including CRLF and SHALL contain no CR, LF or NUL except the single terminating CRLF (P5, line-bound property).

### Requirement 8: Permissions

**User Story:** As an operator, I want an agent's IRC mode to decide what it may do on disk, so that `+o` means "may write" and nothing else does.

#### Acceptance Criteria

1. THE Runner SHALL enforce channel modes only in the `session/request_permission` handler and SHALL NOT implement `fs/*` handlers as an enforcement point.
2. WHILE an Agent has `+o` in the channel, THE Permission_Policy SHALL return `allow_once` for a tool call whose paths all resolve inside the Worktree and whose command does not match the deny list.
3. WHILE an Agent has `+v` and not `+o` in the channel, THE Permission_Policy SHALL return `allow_once` for a read tool call whose paths all resolve inside the Worktree and SHALL return `reject_once` for every write tool call and every shell tool call.
4. WHILE an Agent has no mode in the channel, THE Permission_Policy SHALL return `reject_once` for every tool call, including read tool calls.
5. WHEN a tool call names a path that resolves outside the realpath of the Worktree, including through `..` segments, absolute paths or symlinks, THE Permission_Policy SHALL return `reject_once` regardless of the Agent's mode.
6. WHEN a tool call has a kind or a path that the Permission_Policy cannot classify or resolve (unknown tool kind, empty path, or a path that cannot be resolved), THE Permission_Policy SHALL return `reject_once`.
7. WHEN a command matches the deny list (`rm -rf` targeting a path outside the Worktree, `git push --force`, and package installs from the network), THE Permission_Policy SHALL return `reject_once` regardless of the Agent's mode.
8. WHEN the Permission_Policy returns `reject_once` for a reason other than a missing mode, THE Runner SHALL send one `NOTICE` to the channel within 1 second, addressed to the channel's Human_Ops, naming the Agent, the tool and the reason, and the `NOTICE` text SHALL NOT exceed 512 bytes including CRLF.
9. WHEN a permission request carries an id that is a number or a string, THE Runner SHALL answer with the id unchanged and an `outcome` that selects the option whose `kind` equals the decision.
10. IF the permission request lacks an option whose `kind` equals the decision, or the request is malformed (missing id, missing tool call, or options that are not an array), THEN THE Runner SHALL answer with a cancelled outcome, SHALL NOT select any option, and SHALL log the cause without including secret values.
11. WHEN a permission request arrives, THE Permission_Policy SHALL read the Agent's current mode at the time of that request and SHALL NOT use a mode cached from session creation.
12. WHEN a Private_Session raises a write or shell request, THE Runner SHALL return `reject_once`.
13. THE Permission_Policy SHALL be a pure function of the mode, tool kind, paths, command and Worktree path; it SHALL never return `allow_once` for a path outside the Worktree, it SHALL never return `allow_once` for a write or shell call unless the mode is `+o`, and it SHALL never return `allow_once` for a write whose path is protected (criterion 14) or a shell command that references a protected path (criterion 15) in any mode (P4, permission-purity property).
14. WHEN a write tool call (write, create, rename, move or delete; for a rename or move, the source and the destination) has a canonical path that matches `**/AGENTS.md` compared case-insensitively, or lies under a directory named `.kiro` at any depth compared case-insensitively, THE Permission_Policy SHALL return `reject_once` even for an Agent with `+o`.
15. WHEN a shell command references a protected path of criterion 14 literally (any token or path segment, after removing quotes and backslashes, equal to `AGENTS.md` or `.kiro` compared case-insensitively), THE Permission_Policy SHALL return `reject_once` regardless of the Agent's mode, as part of the deny list of criterion 7. A glob segment (for example `*`, `.ki*` or `./node_modules/*`) is not a reference: a file that such a command creates or changes is caught by the pre-prompt scan (Requirement 4, criterion 14) and the commit-diff check of the Worktree, which are the real defence.
16. THE reason `protected-path` of criteria 14 and 15 SHALL produce the `NOTICE` of criterion 8 to the channel's Human_Ops.

### Requirement 9: Exorcism, ban and hung agents

**User Story:** As an operator, I want `/kick` to stop an agent immediately and cleanly, so that a runaway agent cannot keep working or come back unnoticed.

#### Acceptance Criteria

1. WHEN an `irc.kick` event names an Agent as the target, THE Runner SHALL perform an Exorcism for that Agent in that channel.
2. WHEN the Agent's virtual client receives its own `PART`, THE Runner SHALL perform an Exorcism for that Agent in that channel.
3. WHEN the Runner receives the Agent's `QUIT`, THE Runner SHALL perform an Exorcism for that Agent in every channel in which the Agent has a Session.
4. WHEN the Runner performs an Exorcism, THE Runner SHALL execute these steps strictly in this order: (a) send `session/cancel` only if the Session is `prompting`, (b) wait for the Cooldown to elapse, (c) reset the Worktree, (d) move the Session to `closed`.
5. WHEN an Exorcism runs for a Session that is not `prompting`, THE Runner SHALL send no `session/cancel` and SHALL still perform the Worktree reset and the move to `closed`.
6. WHEN an Exorcism triggered by a `PART` or `KICK` completes and the Agent is still a member of the channel, THE Runner SHALL have the Agent leave the channel with the message `*** <nick> has been exorcised`.
7. WHEN an Exorcism runs, THE Runner SHALL keep the channel log and the git branch unchanged.
8. THE Runner SHALL reset only the Worktree of the channel in which the Agent was removed.
9. IF the Worktree reset fails during an Exorcism, THEN THE Runner SHALL still move the Session to `closed`, SHALL report an error naming the channel and the cause, SHALL leave the Worktree contents as they were, and, for an Exorcism triggered by a `PART` or `KICK` where the Agent is still a member of the channel, SHALL still have the Agent leave the channel with the message `*** <nick> has been exorcised` (the leave does not depend on the reset succeeding).
10. WHEN a `MODE #ch +b <agent nick>` takes effect, or the Runner updates the Ban_List while `+b` is not implemented, THE Runner SHALL add the pair of channel and Agent nick to the Ban_List.
11. WHILE a pair is on the Ban_List, or the inviter is not permitted by the Inviter_Allow_List (Requirement 3, criterion 14), THE Runner SHALL NOT claim the Agent nick in the InviteResolver for that channel, so that the ircd replies `401 ERR_NOSUCHNICK`.
12. WHILE a Turn is in flight and no frame has arrived from the agent process for `SEANCE_PROMPT_TIMEOUT_MS` milliseconds (default 120000), THE Runner SHALL treat the agent process as a Hung_Agent.
13. WHEN the Runner detects a Hung_Agent, THE Runner SHALL send a `NOTICE` with the text `timeout` to every channel in which that process has a `prompting` Session, send `SIGTERM` to the process, and reject every In_Flight_Prompt of that process.
14. WHEN an agent process exits for any reason, THE Runner SHALL move all its Sessions to `closed`, report their queued prompts as dropped, and leave the Agents in their channels.
15. WHEN a new prompt arrives for an Agent whose process has exited, THE Runner SHALL respawn the process and open a new ACP session before sending the prompt.
16. IF the respawn or the new ACP session in criterion 15 fails, THEN THE Runner SHALL drop the prompt and send a `NOTICE` to the channel stating that the Agent could not be started, and SHALL keep the Agent in the channel.
17. IF `SEANCE_PROMPT_TIMEOUT_MS` is set to a value that is not a positive integer, THEN THE Runner SHALL fail to start with an error naming the variable.
18. WHEN an agent session in a channel has had no activity for `SEANCE_IDLE_TIMEOUT_S` seconds, THE Runner SHALL exorcise it with trigger `idle`, exactly like a KICK (session closed, worktree reset, ChanServ notices), then PART the channel with reason `idle for <N> min`. Activity is a channel message addressed to the agent, a queued or in-flight prompt, a streamed session event, or a pending permission request. The idle timer runs only while the session is idle (no prompt in flight, empty queue, no pending permission), so a long-running prompt is never cut by it. Before the KICK-style notices the Runner SHALL send one ChanServ notice `<agent> idle for <N> min, releasing the session`; a later INVITE SHALL start a session as after a KICK. `SEANCE_IDLE_TIMEOUT_S` is an integer from 60 to 86400 (default 900) and applies with `SEANCE_SANDBOX=none` and `podman`; any other value SHALL fail the start with an error naming the variable. `<N>` is the timeout in minutes, rounded to the nearest minute and at least 1. Only a streamed event that arrives while a prompt is in flight (state `prompting`, `cancelling` or `cooldown`) counts as activity; an event that arrives while the session is idle SHALL NOT restart the timer, and a prompt dropped on enqueue (credit-blocked or queue overflow) SHALL NOT count as activity. The same timer applies to a Private_Session (`/query`): on idle the Runner SHALL close it with the teardown it uses on QUIT (session closed, harness session and container removed) and send the human one `NOTICE` `<agent> idle for <N> min, releasing the session`, with no worktree reset and no PART because there is no channel; the next private message SHALL start a fresh Private_Session.

### Requirement 10: Credits and WHOIS

**User Story:** As an operator, I want to see what an agent is, what it is doing and what it has cost, and to cap the cost per channel, so that credits cannot run away.

#### Acceptance Criteria

1. WHEN `_kiro.dev/metadata` carries `meteringUsage` entries with unit `credit`, THE Runner SHALL add the sum of the `value` fields of the accepted entries to the credits of the Session that sent the message before processing the next `_kiro.dev/metadata` message from that Session.
2. IF a `meteringUsage` entry has a unit other than `credit`, a negative value, or a value that is not a finite number, THEN THE Runner SHALL exclude that entry from the sum, SHALL continue to accept the other entries of the same message, and SHALL log one line per rejected entry stating the Session, the unit and the reason for rejection.
3. WHEN a Session's credits change, THE Runner SHALL record the new total in the SessionStore asynchronously, separately from the Whois_Snapshot update of criterion 17, within 1000 ms, so that the total is available after a Runner restart.
4. WHEN the ircd answers `WHOIS` for an Agent, THE Runner's `whoisExtra` function SHALL return, from the Whois_Snapshot, the lines `model: <model>`, `tools: <tool summary>`, `status: <idle|prompting|cooldown|away>` and one `credits: <channel> <n.nn> / total <n.nn>` line for each channel in which the Agent has a Session, with `<n.nn>` as the channel amount and the Agent's total across all channels, each formatted with exactly two decimals.
5. WHILE an Agent has at least one Session in `prompting`, THE Runner SHALL report `status: prompting`.
6. WHILE an Agent has no Session in `prompting` and at least one Session in `cooldown`, THE Runner SHALL report `status: cooldown`.
7. WHILE an Agent has no Session in `prompting` or `cooldown` and its `AWAY` is set, THE Runner SHALL report `status: away`.
8. WHILE an Agent has no Session in `prompting` or `cooldown` and its `AWAY` is not set, THE Runner SHALL report `status: idle`.
9. WHERE `SEANCE_CHANNEL_CREDIT_CAP` is set to a positive number, WHEN the sum of credits of all Sessions in a channel exceeds it, THE Runner SHALL cancel the In_Flight_Prompts of that channel, send one `NOTICE` naming the channel, the total and the cap to each Human_Op of the channel, and mark the channel as credit-blocked.
10. WHILE a channel is credit-blocked, THE Runner SHALL refuse to send new prompts for its Sessions and SHALL report each refused prompt as dropped.
11. WHEN a Human_Op of a credit-blocked channel sends `PRIVMSG <agent> :!reset-credits`, THE Runner SHALL clear the credit-blocked mark for each of the Agent's channels in which that human has `+o`, SHALL leave the mark in place for the other channels, and SHALL send a `NOTICE` to that human naming the channels that were cleared.
12. IF a human without `+o` in any credit-blocked channel of the Agent sends `!reset-credits`, THEN THE Runner SHALL leave the blocks in place and reply with a `NOTICE` stating that operator rights are required.
13. IF `SEANCE_CHANNEL_CREDIT_CAP` is set to a value that is not a finite number greater than zero, THEN THE Runner SHALL exit at startup with a non-zero status and an error message naming the variable and the rejected value.
14. THE Runner SHALL treat the text `!reset-credits` as a command only in a private message and only from a Human_Op, and SHALL NOT forward it to the Agent as a prompt.
15. FOR ALL sequences of `_kiro.dev/metadata` messages, the credits of a Session SHALL never decrease and SHALL equal the sum of the accepted `meteringUsage` values reported for it (P6, credit-accumulation property).
16. IF a human who is not a Human_Op sends `!reset-credits` in a private message and no channel of the Agent is credit-blocked, THEN THE Runner SHALL discard the message without forwarding it to the Agent and SHALL reply with a `NOTICE` stating that no channel is credit-blocked.
17. WHEN a Session_State change, a credit change or an `AWAY` change occurs for an Agent, THE Runner SHALL update that Agent's entry in the Whois_Snapshot synchronously, before the Runner processes the next event for that Agent.
18. THE `whoisExtra` function SHALL be synchronous and SHALL read only the Whois_Snapshot, performing no I/O, no `await` and no SessionStore call, and SHALL return within the same event-loop tick as the call.
19. IF the Whois_Snapshot has no entry for the Agent, or only a partial entry, THEN THE `whoisExtra` function SHALL return an empty list or only the lines derivable from the partial entry, and SHALL NOT throw.
20. FOR ALL Whois_Snapshot contents, including empty ones, THE `whoisExtra` function SHALL return a `readonly string[]` without throwing, and the value SHALL be identical to the value computed from the same snapshot a second time (purity property).

### Requirement 11: Shutdown

**User Story:** As an operator, I want the server to stop cleanly, so that no agent keeps running and spending credits after it exits.

#### Acceptance Criteria

1. WHEN the Runner receives `SIGTERM` for the first time, THE Runner SHALL enter the shutdown state, stop accepting new invitations and new prompts, and start the shutdown sequence.
2. WHILE the Runner is in the shutdown state, THE Runner SHALL reject every new invitation and every new prompt without starting a Session or sending anything to an agent process.
3. WHEN the shutdown sequence starts, THE Runner SHALL send a cancel request to every Session that is `prompting`, wait for each Session's Cooldown to elapse, and only then begin terminating agent processes.
4. WHEN the Cooldown of every cancelled Session has elapsed, or no Session was `prompting`, THE Runner SHALL send `SIGTERM` to every agent process it started.
5. IF an agent process is still alive 5 seconds after receiving `SIGTERM`, THEN THE Runner SHALL send `SIGKILL` to that process.
6. WHEN every agent process has exited, THE Runner SHALL disconnect each Agent's virtual client so that the Agent leaves all of its channels.
7. WHEN the shutdown sequence completes, THE Runner SHALL hold no child process, timer or open handle that it created, so that the Node.js process exits without being forced.
8. IF `SIGTERM` or another shutdown request arrives while the Runner is already in the shutdown state, THEN THE Runner SHALL ignore it and run the shutdown sequence exactly once.
9. THE Runner SHALL leave every Worktree unmodified during shutdown, so that uncommitted work is still present after a restart.

### Requirement 12: Test fixtures and tooling

**User Story:** As a maintainer, I want every test to run against a scriptable fake agent, so that the suite is fast, deterministic and spends no credits.

#### Acceptance Criteria

1. THE Runner package SHALL contain a Fake_Agent, a Node script under `apps/runner/test/fixtures` that speaks newline-delimited JSON-RPC 2.0 on stdio, with one JSON object per line terminated by `\n`.
2. THE Fake_Agent SHALL be scriptable to emit message chunks, thought chunks, tool calls, `session/request_permission` requests with string ids, `_kiro.dev/metadata` messages, slow turns with a configurable delay of 0 to 600,000 ms, cancelled turns, process crashes with a configurable non-zero exit code, and a `session/new` response whose `modes.currentModeId` differs from the requested agent name (for example `kiro_default`).
3. WHEN the Fake_Agent receives `initialize`, `session/new`, `session/prompt` or `session/cancel`, THE Fake_Agent SHALL answer in the same response shape as `kiro-cli acp`, with `stopReason` set to `end_turn` for a completed Turn and `cancelled` for a cancelled Turn.
4. IF the Fake_Agent receives a `session/prompt` while the previous cancelled Turn has not been followed by a Cooldown, THEN THE Fake_Agent SHALL resolve that prompt with `stopReason` `cancelled`, reproducing the cancel-then-reuse race from the spike.
5. IF the Fake_Agent receives a line that is not valid JSON-RPC 2.0, THEN THE Fake_Agent SHALL reply with a JSON-RPC error for that line and keep running.
6. THE Runner package SHALL run every unit, property and integration test against the Fake_Agent, start zero `kiro-cli` processes and spend zero Credits.
7. THE Runner package SHALL provide a `test` script that runs `vitest run`, and `pnpm test` at the repository root SHALL run it through turbo.
8. THE Runner package SHALL implement properties P1 to P6 with fast-check at 100 runs or more each, with each test tagged `Feature: agent-runner` and named by its property ID.
9. THE Runner tests SHALL use fake timers for Cooldown, Idle_Flush and timeout behaviour and SHALL call no wall-clock sleep.
10. THE Runner tests SHALL create Worktrees only in operating-system temporary directories and SHALL remove each Worktree after its test, including when the test fails.
11. WHERE `SEANCE_E2E_KIRO=1` is set, THE Runner package SHALL run one end-to-end test with a real `kiro-cli` that invites an agent, sends one prompt, receives a non-empty answer and shuts down within 10,000 ms, leaving zero `kiro-cli` child processes.
12. WHEN `SEANCE_E2E_KIRO` is unset or not equal to `1`, THE Runner package SHALL skip the end-to-end test and vitest SHALL report it as skipped.
13. THE Runner package SHALL pass `pnpm typecheck` and `pnpm lint` with zero errors using the shared strict `tsconfig.base.json`, without loosening any compiler option.
14. THE Runner package SHALL include a test in which the Fake_Agent returns a wrong `modes.currentModeId` from `session/new` and which asserts that the session is closed, the process receives `SIGTERM`, the inviter receives the `NOTICE` `agent profile <name> not loaded`, and the Fake_Agent recorded zero `session/prompt` requests.
