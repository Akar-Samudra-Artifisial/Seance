# Requirements Document

## Introduction

`runner-services` makes the runner speak in the voice of two IRC services, `ChanServ` and `NickServ`, as shown in the Figma mockup. A service line is a `NOTICE` that tells a human something the runner knows to be true: a channel worktree exists, a session was stopped, which agents can be invited. Nothing is invented. A notice is sent only when the fact behind it holds, and every number comes from state the runner already keeps.

The notice texts were read from the mockup with Talk-to-Figma (channel `8p9g0i9k`) on 2026-11-08:

| Frame | Node | Text |
|---|---|---|
| 01 Main | 1:1354 | `-ChanServ- worktree ready: .seance/wt/fix-bug-123 @ a1b2c3d` |
| 01 Main, 03 Kick | 1:1379, 1:4730 | `-ChanServ- coder touched 6 files outside topic scope` (out of scope, see Non-goals) |
| 03 Kick | 1:4731 | `-ChanServ- session cancelled, worktree reset to a1b2c3d` |
| 03 Kick | 1:4732 | `-ChanServ- 6 files reverted · 4.1 credits released` |
| 02 Status | 1:2768 | `-NickServ- agents online: coder, reviewer, researcher (idle)` |
| 02 Status | 1:2769 | `-ChanServ- 2 sessions restored from last séance: #fix-bug-123, #landing-page` |

The user brief placed "session cancelled" and "credits released" in frame 01. They are in frame 03 (Kick moment). The mockup values (`.seance/wt/...`, `4.1`, `6 files`) are sample data.

Where the mockup wording would claim something the runner cannot make true, this spec deviates and says so in `design.md` (decisions D4, D5, D6): the "credits released" word, the worktree path and the "sessions restored" line. The service nicks are reserved in the ircd. The web client changes only as far as needed to render a `-Service-` notice in the right window.

## Glossary

- **Service:** one of the pseudo users `ChanServ` and `NickServ`. A Service has no connection, no channel membership and no `WHOIS` entry; it exists only as the prefix of a `NOTICE`.
- **Service_Nick:** the exact spellings `ChanServ` and `NickServ`. Comparison uses rfc1459 case-mapping (`irc_lower`).
- **Service_Notice:** a `NOTICE` whose prefix is `<Service>!<Service>@services.<server name>` and whose target is a channel or a nick.
- **Ircd:** the server in `apps/ircd`.
- **Runner:** the library in `apps/runner`. It decides when a Service_Notice is true and what it says.
- **Registry:** the `AgentRegistry` of loaded Agent_Profiles.
- **Snapshot:** the `WhoisSnapshot` that renders the `320` lines of `WHOIS`.
- **Ledger:** the `CreditLedger` that feeds the Snapshot.
- **Worktree_Notice_Dir:** the last two path segments of a channel worktree, `<basename of SEANCE_WORKSPACES>/<sanitized channel>`. No absolute path appears in IRC.
- **Short_Sha:** the seven-character abbreviation of a commit, from `git rev-parse --short=7`.
- **Dirty_File:** one path reported by `git status --porcelain=v1 -z --untracked-files=all --no-renames` in a worktree.

## Non-goals

- Persisting sessions across a runner restart, and with it the line `N sessions restored from last séance` (D6). The line is never sent.
- `coder touched N files outside topic scope`. It needs a topic-to-path relevance rule that does not exist; any text would be a guess.
- Services that answer commands (`/msg NickServ ...`), password registration, channel registration, `/ns`, `/cs`. A message to a Service gets `401 ERR_NOSUCHNICK`.
- A model-backed ChanServ agent. The notices are produced by code, without a model call.
- Any new web UI beyond routing and rendering of `-Service-` notices.

---

## Requirements

### Requirement 1: Reserved service nicks

**User Story:** As an operator, I want `ChanServ` and `NickServ` to belong to the network, so that nobody can impersonate a service line.

#### Acceptance Criteria

1. THE `@seance/irc-protocol` package SHALL export `SERVICE_NICKS` (`["ChanServ", "NickServ"]`) and `isServiceNick(nick)`, which returns true exactly when `irc_lower(nick)` equals `irc_lower` of a Service_Nick.
2. WHEN a client sends `NICK` with a Service_Nick, in any letter case or with the rfc1459 case pairs `[]\^` / `{}|~`, THE Ircd SHALL reply `432 ERR_ERRONEUSNICKNAME` with the text `Nickname is reserved for network services`, SHALL keep the previous nick, and SHALL NOT register the client.
3. THE rule in criterion 2 SHALL apply to network clients, to the WebSocket transport and to virtual clients, because all of them go through the same `CommandRouter` handler.
4. WHEN the Registry loads a profile whose nick is a Service_Nick, THE Registry SHALL reject that file with an `AgentProfileError` naming the file and the field `nick`, SHALL register no profile from it, and SHALL continue with the other files.
5. A `WHOIS` or `PRIVMSG` addressed to a Service_Nick SHALL get `401 ERR_NOSUCHNICK`, as for any unknown nick. THE Ircd SHALL NOT answer any command on behalf of a Service.

### Requirement 2: Service_Notice delivery in the Ircd

**User Story:** As a client user, I want a service line to look like `-ChanServ- text` in every IRC client, so that irssi and HexChat show it like any other notice.

#### Acceptance Criteria

1. THE Ircd SHALL provide `serviceNotice(service, target, text)`. WHEN `target` is an existing channel, it SHALL send one `NOTICE <channel> :<text>` with the Service prefix to every current member. WHEN `target` is a registered nick, it SHALL send one `NOTICE <nick> :<text>` to that client. Otherwise it SHALL return false and send nothing.
2. THE Ircd SHALL bypass channel modes (`+m`, `+n`) for a Service_Notice, because a Service is not a member.
3. THE Ircd SHALL remove CR, LF and NUL from `text` and SHALL cut it at a code point boundary so the serialized line, with prefix, target and CRLF, is at most 512 UTF-8 bytes.
4. A Service_Notice SHALL NOT be published as an `irc.message` event, so it never reaches an agent prompt and never counts as channel traffic for `PRIVMSG` rate limits or the channel log.
5. THE `IrcHost` port of the Runner SHALL expose `serviceNotice` with the same contract, and `apps/ircd/src/runner-wiring.ts` SHALL adapt it. The Runner SHALL NOT import `@seance/ircd`.
6. A failing delivery SHALL be logged with service, target and cause, and SHALL NOT throw into the caller.

### Requirement 3: Registration event

**User Story:** As the runner, I want to know when a human finishes registering, so that NickServ can greet them once.

#### Acceptance Criteria

1. WHEN a client completes registration, after the welcome burst and MOTD, THE Ircd SHALL publish `irc.register` with `{ nick, virtual }` exactly once for that client.
2. THE event SHALL carry no host, user, password or address.
3. The Ircd SHALL publish no `irc.register` event for a rejected registration.

### Requirement 4: NickServ agent roster

**User Story:** As an operator, I want to see which agents I can summon the moment I connect, so that I know what the runner offers.

#### Acceptance Criteria

1. WHEN `irc.register` arrives for a non-virtual client while the Runner is started and not shutting down, THE Runner SHALL send that nick one Service_Notice from `NickServ`: `agents online: <groups>`.
2. `<groups>` SHALL list every Agent_Profile of the Registry once, in Registry order, grouped by status. The status of an agent is computed by the function that renders the `status:` line of `WHOIS` (`idle`, `prompting`, `cooldown`, `away`), so both always agree. A group is `<nick>, <nick> (<status>)`; groups are joined by `; `. A Registry whose agents all share a status gives the mockup form `coder, reviewer, researcher (idle)`.
3. THE Runner SHALL send no roster notice when the Runner is not started, is shutting down, or the client is virtual.
4. THE roster SHALL NOT name an agent that is absent from the Registry, and SHALL NOT omit one that is present.

### Requirement 5: ChanServ worktree notice

**User Story:** As an operator, I want to be told when a channel gets its sandbox, and which commit it starts from.

#### Acceptance Criteria

1. WHEN the invite pipeline calls `WorktreeManager.ensure` and the result has `created === true`, THE Runner SHALL send one Service_Notice from `ChanServ` to the channel: `worktree ready: <Worktree_Notice_Dir> @ <Short_Sha>`, with the Short_Sha of the worktree `HEAD`.
2. WHEN `ensure` reuses an existing worktree, THE Runner SHALL send no notice.
3. IF the Short_Sha cannot be read, THEN THE Runner SHALL log the cause and SHALL send no notice. It SHALL NOT print a placeholder.
4. THE text SHALL contain no absolute path, no user home directory and no repository path.
5. A failed `ensure` SHALL produce no `worktree ready` notice.

### Requirement 6: ChanServ session end notices

**User Story:** As an operator, I want a record in the channel of what a `/kick` did, so that the audit trail shows the stop and the revert.

#### Acceptance Criteria

1. WHEN the exorcism of an agent triggered by `kick` or `part` finishes the worktree reset without error, THE Runner SHALL send one Service_Notice from `ChanServ` to the channel: `session cancelled, worktree reset to <Short_Sha>` if a prompt was in flight when the exorcism began, otherwise `session closed, worktree reset to <Short_Sha>`.
2. `<Short_Sha>` SHALL be the commit the reset moved the worktree to, as reported by the reset itself.
3. WHEN the reset reverted at least one Dirty_File, or the Ledger holds credits above zero for the pair (agent, channel), THE Runner SHALL send a second Service_Notice: `<N> file(s) reverted · <X.XX> credits used`. `N` is the number of Dirty_Files counted before the reset (`1 file`, `N files`); `X.XX` is `CreditLedger.amount(agent, channel)` formatted with `toFixed(2)`, the value `WHOIS` shows in `credits: <channel> <used> / total <total>`.
4. IF the reset fails, THEN THE Runner SHALL send no session end notice. The existing error report to the Human_Ops remains the only message.
5. THE Runner SHALL send no session end notice for the `quit` trigger, and none when the channel no longer exists.
6. Both notices SHALL be sent before the agent leaves, in the order of criteria 1 and 3, and at most once per exorcism (the exorcism is single-flight per Invite_Key).

### Requirement 7: Truthfulness

**User Story:** As a user, I want to trust a service line without checking it.

#### Acceptance Criteria

1. THE Runner SHALL send a Service_Notice only from code that has just observed the fact it states; no notice text SHALL be built from a constant count, a sample value or a mock path.
2. THE Runner SHALL NOT send any notice about restored sessions.
3. EVERY number in a Service_Notice SHALL come from the same source as `WHOIS 320`: `CreditLedger` for credits, the Snapshot for status. A property test SHALL check that notice and `WHOIS` agree.
4. THE notice texts SHALL be built by pure functions in `apps/runner/src/services/notices.ts` and tested without IRC.

### Requirement 8: Web client rendering

**User Story:** As a web user, I want `-NickServ- ...` in the Status window and `-ChanServ- ...` in the channel, as in the mockup.

#### Acceptance Criteria

1. WHEN a `NOTICE` arrives from a Service_Nick and its target is the own nick, THE web client SHALL append the line to the Status window as `kind: "notice"` with `from` set to the service nick. It SHALL NOT open a query window.
2. WHEN a `NOTICE` from a Service_Nick targets a channel window, the existing channel path SHALL render it as `-ChanServ- text`.
3. THE client SHALL use `isServiceNick` from `@seance/irc-protocol`, not a second list.
4. A `PRIVMSG` from a Service_Nick SHALL keep the current behaviour. No other client behaviour changes.

### Requirement 9: Tests

**User Story:** As a maintainer, I want the notices pinned by tests at three levels.

#### Acceptance Criteria

1. Unit and property tests SHALL cover the formatters of Requirement 7.4 (Properties P1 to P4 in `design.md`).
2. Ircd tests SHALL cover Requirements 1 to 3 (reserved nicks, delivery, no `irc.message`, the registration event).
3. Integration tests with the Fake_Agent (`apps/runner/test/fixtures`) SHALL cover Requirements 4 to 6 end to end through a real ircd: worktree notice once, roster text, session cancelled versus closed, reverted count equal to the files the Fake_Agent wrote, credits equal to the `WHOIS` line.
4. Web tests SHALL cover Requirement 8, including a property that no service notice ever opens a query window.
5. A test SHALL assert that no produced notice contains the trademarked client name that `product.md` forbids. The test builds the term from two fragments, so the forbidden word does not appear in the test source either.

### Requirement 11: Agent-to-agent loop guard

**User Story:** As an operator, I want two agents in one channel to stop talking to each other on their own, so that an `ok` / `ok` exchange cannot burn credits until I step in.

Added 2026-11-08 at the user's request. Today every voiced Agent receives every channel `PRIVMSG` of another Agent as a prompt, so two `+v` agents answering `ok` keep prompting each other without end.

#### Acceptance Criteria

1. WHEN a channel `PRIVMSG` comes from a Known_Agent (a nick of the Registry), THE Runner SHALL NOT prompt another Agent with it unless the text mentions that Agent's nick. A mention is the nick as a whole word, compared with rfc1459 case-mapping after IRC formatting codes (colour, bold, reset and the other control characters) are removed. The nick characters `A-Z a-z 0-9 - [ ] \ ` ^ { } | _` count as word characters.
2. A `NOTICE` from a Known_Agent, to a channel or to an Agent's nick, and a private `PRIVMSG` from a Known_Agent SHALL never prompt an Agent, mentioned or not. This is today's behaviour; the guard keeps it.
3. FOR each pair (Agent, channel), THE Runner SHALL count the prompts that Agent received from other Agents' messages since the last resetting message (criterion 4) in that channel. A prompt that needs a revived Session SHALL count only when the revival succeeds; a failed revival gives the count back. WHILE the count is 3 (`AGENT_REPLY_LIMIT`), THE Runner SHALL drop further prompts from Agents to that Agent in that channel, SHALL log the drop once per limit episode (agent, channel, limit) and SHALL send no IRC text about it.
4. WHEN a channel `PRIVMSG` arrives from a channel member with `+v` or `+o` who is not a Known_Agent, THE Runner SHALL reset the counts of every Agent in that channel to zero, before any other routing step and also when no Session is open in the channel. A `PRIVMSG` from a nick without a mode, from a non-member or from a Known_Agent SHALL NOT reset the counts (amended 2026-11-08 after review: an unmoded nick or a bot must not be able to restart an agent loop). No human message is ever dropped by the guard; the existing mode rules (no mode = listen only, `+m`) still apply.
5. Counts SHALL be kept per channel and per Agent with rfc1459 case-mapping, SHALL NOT carry over to another channel, SHALL be forgotten for a channel when its last open Session is removed or closed, and SHALL be forgotten entirely when the runner shuts down. The guard SHALL hold no more than one entry per (Agent, channel) pair that has a Session.
6. THE guard SHALL decide before a prompt is built or a Session is revived, so a dropped message never starts an agent process, never counts credits and never reaches the channel log of a prompt. The channel log itself (`ChannelLog`) still records the message, as for any channel line.
7. THE decision SHALL be a pure function (`apps/runner/src/session/agent-loop-guard.ts`) covered by a property test, and an integration test with two `+v` Fake_Agents SHALL show that an `ok` / `ok` exchange stops: without mentions after the first round, with mutual mentions after `AGENT_REPLY_LIMIT` replies each, and that a new human message allows one more bounded round.

### Requirement 10: Documentation and naming

**User Story:** As a reviewer, I want the design document to match the behaviour.

#### Acceptance Criteria

1. `DESIGN.md` SHALL describe the two services, the reserved nicks, the deviations D4 to D6, and SHALL state that the Kiro agent list no longer names a `chanserv` agent.
2. THE trademarked client name forbidden by `product.md` SHALL NOT appear in any file this spec adds or changes, including this spec. "Classic IRC client" is the permitted description.
3. All text, comments and commit messages SHALL be English.
