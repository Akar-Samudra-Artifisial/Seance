# Requirements Document

## Introduction

`ircd-agent-commands` extends the `ircd-core` server in `apps/ircd` with the three commands that expose agent state to a human operator: `AWAY`, `WHOIS` and `INVITE` (`DESIGN.md` §3, "Command → agent mapping"). It also adds a metadata hook so virtual clients can describe themselves in `WHOIS` output, an `InviteResolver` hook so the future agent runner can claim nicks that are not connected, normalization of peer addresses before they become `client.host`, and fixes for two leftover Minor review findings (unclamped reflected input in error numerics, and an unnecessary destroy timer in `NetworkClient.close`).

The spec reuses `CommandRouter`, `ChannelRegistry`, `ConnectionManager`, `EventBus`, `clampTrailing` and `Numerics`. Nothing in `apps/runner` changes; the runner will later implement `whoisExtra` and the `InviteResolver`.

## Glossary

- **IRCd:** the server in `apps/ircd`; the system under test and the subject of every requirement unless another system is named.
- **Client:** any connection to the IRCd over TCP, WebSocket or the in-process virtual client interface.
- **Network client:** a TCP or WebSocket connection (`NetworkClient`).
- **Virtual client:** an in-process client created with `createVirtualClient`.
- **Registered client:** a client that has completed `NICK`/`USER` registration.
- **Channel operator:** a member with mode `+o` in a channel.
- **Voiced member:** a member with mode `+v` in a channel.
- **Line limit:** 512 bytes including CRLF, measured in UTF-8 bytes.
- **AWAYLEN:** the maximum length of an away message, 200 UTF-8 bytes.
- **Away text:** the free-text reason stored in `client.away` while a client is marked away.
- **Clamp:** cut free text at the nearest preceding UTF-8 code point boundary so the serialized line fits within a stated byte limit, using `clampTrailing` from `text-limits.ts`.
- **Whois extra lines:** the strings returned by the optional `whoisExtra()` method of a Client.
- **RPL_WHOISSPECIAL (320):** the de facto numeric used by common servers (ircu, UnrealIRCd, Ergo) for free-text `WHOIS` lines. It is not defined in RFC 2812. It is the only numeric in this spec that is not in RFC 2812.
- **Last activity:** the time of the most recent accepted `PRIVMSG` or `NOTICE` sent by a client, or its sign-on time if it has sent none.
- **Sign-on time:** the time at which a client completed registration, in whole Unix seconds.
- **Idle time:** the number of whole seconds between the current time and the Last activity, with a minimum of 0.
- **InviteResolver:** a server-level hook that is asked whether an unconnected nick is an invitable name and, when it claims the nick, takes responsibility for the invitation.
- **Invite record:** an entry in a channel's `invited` set naming a nick that has been invited and has not yet joined.
- **Peer address:** the remote address string reported by the transport socket.
- **normalizeHost:** the single function that maps a peer address to the value stored in `client.host`.
- **Reflected input:** user-supplied text (nick, channel name, command name) echoed back in a numeric reply parameter.
- **Grace period:** the `closeGraceMs` interval a network client waits after ending its wire before destroying it.

---

## Requirements

### Requirement 1: AWAY command

**User Story:** As an operator, I want to mark myself away and see who is away, so that I know when an agent is busy.

#### Acceptance Criteria

1. WHEN a registered client sends `AWAY` with a non-empty text parameter, THE IRCd SHALL store the text, clamped to AWAYLEN (200 UTF-8 bytes) and to the line limit, as the client's away text and reply `306 RPL_NOWAWAY`.
2. WHEN a registered client sends `AWAY` with no parameter or an empty text parameter, THE IRCd SHALL clear the client's away text, retain no previous away text, and reply `305 RPL_UNAWAY`.
3. THE IRCd SHALL advertise `AWAYLEN=200` in the `005 RPL_ISUPPORT` reply sent at registration.
4. WHEN a registered client sends `PRIVMSG` to a nick whose client has away text, THE IRCd SHALL deliver the message and reply to the sender with exactly one `301 RPL_AWAY` carrying the target nick and the target's current away text.
5. WHEN a client sends `NOTICE` to a nick whose client has away text, THE IRCd SHALL deliver the notice and send zero `301 RPL_AWAY` replies.
6. WHEN a client sends `PRIVMSG` to a channel, THE IRCd SHALL send zero `301 RPL_AWAY` replies, even if a member of the channel has away text.
7. WHEN away text is set on a virtual client through the virtual client interface, THE IRCd SHALL clamp the text to AWAYLEN bytes before storing it.
8. WHEN away text is clamped, THE IRCd SHALL cut the text at a UTF-8 code point boundary, store text that is valid UTF-8, and log nothing at error level.
9. IF an unregistered client sends `AWAY`, THEN THE IRCd SHALL reply `451 ERR_NOTREGISTERED`, leave the client's away text unchanged and send neither `305` nor `306`.
10. FOR ALL sequences of one or more `AWAY` commands sent by one registered client, a subsequent `PRIVMSG` to that client SHALL produce `301 RPL_AWAY` if and only if the last `AWAY` in the sequence carried non-empty text (away state property).

### Requirement 2: WHOIS command

**User Story:** As an operator, I want to inspect a user, so that I can see who is behind a nick and which channels it is in.

#### Acceptance Criteria

1. WHEN a registered client sends `WHOIS <nick>` for a registered nick, THE IRCd SHALL reply with `311 RPL_WHOISUSER`, `319 RPL_WHOISCHANNELS` (when the target is in at least one channel), `312 RPL_WHOISSERVER`, the lines required by Requirement 3, `301 RPL_AWAY` (when the target has away text), `317 RPL_WHOISIDLE`, and `318 RPL_ENDOFWHOIS`, in that order, with `301` placed after the Requirement 3 lines.
2. WHEN a registered client sends `WHOIS <server> <nick>`, THE IRCd SHALL ignore the server parameter and process the command as `WHOIS <nick>`.
3. WHEN the IRCd sends `311 RPL_WHOISUSER`, THE IRCd SHALL include the target's nick, user name, host and real name.
4. WHEN the IRCd sends `319 RPL_WHOISCHANNELS`, THE IRCd SHALL list the canonical name of every channel the target is a member of, prefixing each channel with `@` for a channel operator, with `+` only for a voiced member that is not also a channel operator, and with no prefix for other members.
5. WHEN the `319` channel list would exceed the line limit of 512 bytes including CRLF, measured in UTF-8 bytes, THE IRCd SHALL split the list across multiple `319` lines so that each emitted line is within that limit, without splitting any channel entry across two lines.
6. WHEN the IRCd sends `312 RPL_WHOISSERVER`, THE IRCd SHALL include the server name and a server description.
7. WHEN the IRCd sends `317 RPL_WHOISIDLE`, THE IRCd SHALL include the target's Idle time as a whole number of seconds that is at least 0, and its sign-on time in Unix seconds.
8. IF the target nick is not a registered client, THEN THE IRCd SHALL reply `401 ERR_NOSUCHNICK` followed by `318 RPL_ENDOFWHOIS` for that nick, and send none of `311`, `319`, `312`, `301` and `317`.
9. IF a client sends `WHOIS` with no nick parameter, THEN THE IRCd SHALL reply `431 ERR_NONICKNAMEGIVEN` and send no `318`.
10. IF an unregistered client sends `WHOIS`, THEN THE IRCd SHALL reply `451 ERR_NOTREGISTERED` and send no `318`.
11. THE IRCd SHALL end every processed `WHOIS` that names a nick with exactly one `318 RPL_ENDOFWHOIS`.
12. FOR ALL registered targets, the set of channels in the `319` lines SHALL equal the set of channels in which the target is a member, each with the prefix that matches the target's membership flags (membership listing property).
13. FOR ALL nicks, channel names, away text and Whois extra lines, including multi-byte UTF-8, every reply produced by `WHOIS` SHALL serialize to at most 512 bytes including CRLF (line-bound property).
14. WHEN a registered client sends `WHOIS` with a comma-separated nick list, THE IRCd SHALL process only the first nick in the list and ignore the remaining nicks.

### Requirement 3: Whois metadata hook

**User Story:** As an operator, I want `WHOIS` on an agent to show its model, tools, session status and credits, so that I can see what the agent may do and what it costs.

#### Acceptance Criteria

1. THE Client interface SHALL declare an optional method `whoisExtra()` that takes no arguments and returns a readonly array of strings.
2. WHEN the IRCd answers `WHOIS` for a target whose Client implements `whoisExtra()`, THE IRCd SHALL send one `320 RPL_WHOISSPECIAL` line for each returned string, in the returned order, with parameters `<me> <nick> :<line>`, after `312 RPL_WHOISSERVER` and before `318 RPL_ENDOFWHOIS`.
3. WHEN the IRCd sends a `320 RPL_WHOISSPECIAL` line, THE IRCd SHALL clamp the line text so the serialized message is within the line limit.
4. WHEN a Client does not implement `whoisExtra()` or returns an empty array, THE IRCd SHALL send no `320` line for that target and still send the other `WHOIS` replies.
5. WHERE a virtual client supplies a `whoisExtra` function when it is created, THE IRCd SHALL call that function exactly once per `WHOIS` of the virtual client and return its result.
6. THE NetworkClient SHALL return an empty array from `whoisExtra()` or leave `whoisExtra()` unimplemented.
7. IF `whoisExtra()` throws, THEN THE IRCd SHALL log an entry containing the command name `WHOIS`, the client id and the error cause, omit the `320` lines for that target, keep the requester's connection open, and still send the remaining `WHOIS` replies including `318`.

### Requirement 4: Activity and sign-on tracking

**User Story:** As an operator, I want accurate idle and sign-on times, so that `WHOIS` shows whether a user is active.

#### Acceptance Criteria

1. WHEN a client completes registration, THE IRCd SHALL record the sign-on time in whole seconds from the injectable clock and set the last activity time equal to it.
2. WHEN a registered client sends `PRIVMSG` or `NOTICE` that the IRCd accepts for processing, THE IRCd SHALL set that client's last activity time to the current time.
3. WHEN a client sends `PING`, `PONG` or any command other than `PRIVMSG` and `NOTICE`, THE IRCd SHALL leave that client's last activity time unchanged.
4. WHEN a virtual client sends a `PRIVMSG` or `NOTICE` that the IRCd accepts for processing, THE IRCd SHALL set that virtual client's last activity time to the current time, and THE IRCd SHALL record the virtual client's sign-on time in the same way as for network clients.
5. THE IRCd SHALL read the current time from the injectable clock already used by the IRCd, so that tests can control it.
6. IF a `PRIVMSG` or `NOTICE` is rejected because of a missing recipient, missing text, a nonexistent target or the rate limit, THEN THE IRCd SHALL leave the sender's last activity time unchanged.
7. WHEN the IRCd computes the idle time for `WHOIS`, THE IRCd SHALL use the current time minus the target's last activity time, in whole seconds, with a minimum of 0.

### Requirement 5: INVITE command

**User Story:** As an operator, I want to invite a user or agent to a channel, so that I can bring the right agent into a task.

#### Acceptance Criteria

1. WHEN a channel operator sends `INVITE <nick> <#channel>` for an existing channel the operator is in, naming a registered nick that is not a member of the channel, THE IRCd SHALL reply `341 RPL_INVITING` to the inviter with the target nick and the canonical channel name.
2. WHEN the IRCd accepts an `INVITE`, THE IRCd SHALL send the target exactly one message `:<inviter nick>!<user>@<host> INVITE <target nick> <canonical channel name>`.
3. WHEN the IRCd accepts an `INVITE`, THE IRCd SHALL publish exactly one `irc.invite` event on the EventBus carrying the canonical channel name, the inviter nick, the target nick and a timestamp `ts` in milliseconds since the Unix epoch.
4. IF an `INVITE` has fewer than two parameters, THEN THE IRCd SHALL reply `461 ERR_NEEDMOREPARAMS` reflecting the command name `INVITE`.
5. IF the channel does not exist, THEN THE IRCd SHALL reply `403 ERR_NOSUCHCHANNEL` reflecting the channel name as sent by the inviter.
6. IF the inviter is not a member of the channel, THEN THE IRCd SHALL reply `442 ERR_NOTONCHANNEL`.
7. IF the inviter is a member of the channel but not a channel operator, THEN THE IRCd SHALL reply `482 ERR_CHANOPRIVSNEEDED` and invite nobody, because invited agents spend credits.
8. IF the target nick is not a registered client and no InviteResolver claims it, THEN THE IRCd SHALL reply `401 ERR_NOSUCHNICK` reflecting the nick as sent by the inviter.
9. IF the target is already a member of the channel, THEN THE IRCd SHALL reply `443 ERR_USERONCHANNEL` and invite nobody.
10. IF an unregistered client sends `INVITE`, THEN THE IRCd SHALL reply `451 ERR_NOTREGISTERED` and perform no other checks.
11. WHEN the IRCd rejects an `INVITE`, THE IRCd SHALL send the inviter exactly one error reply, send nothing to the target, add no Invite record and publish no `irc.invite` event.
12. WHEN the IRCd evaluates an `INVITE`, THE IRCd SHALL apply the checks in this order: parameter count, channel existence, inviter membership, inviter operator status, target resolution, target membership, and SHALL stop at the first failing check.
13. THE IRCd SHALL compare the target nick and channel name using rfc1459 case-mapping.
14. FOR ALL nicks, channel names and prefixes, including multi-byte UTF-8, every reply produced by `INVITE` SHALL serialize to at most 512 bytes including CRLF (line-bound property).

### Requirement 6: InviteResolver hook

**User Story:** As the agent runner, I want to claim invitations for agents that are not connected yet, so that `/invite coder` can spawn the agent.

#### Acceptance Criteria

1. THE IRCd SHALL accept an optional InviteResolver when the server is created, with no resolver as the default.
2. WHEN an `INVITE` passes the checks for parameters, channel, inviter membership and inviter operator status and names a nick that is not a registered client, THE IRCd SHALL ask the InviteResolver, if one is configured, whether it claims the nick.
3. WHEN the InviteResolver claims the nick, THE IRCd SHALL reply `341 RPL_INVITING` to the inviter, publish `irc.invite` with the nick as target, record the invite, and send no `INVITE` message to any client.
4. WHEN the InviteResolver does not claim the nick, THE IRCd SHALL reply `401 ERR_NOSUCHNICK`.
5. WHEN the target nick is a registered client, THE IRCd SHALL NOT ask the InviteResolver.
6. IF the InviteResolver throws or rejects, THEN THE IRCd SHALL log the failure with the command and client id, reply `401 ERR_NOSUCHNICK`, publish no `irc.invite` event, add no Invite record, and keep serving other clients without effect on them.
7. THE IRCd SHALL pass the InviteResolver exactly three plain strings: the target nick, the canonical channel name and the inviter nick, so that the resolver holds no reference that lets it mutate IRCd state.
8. IF no InviteResolver is configured and the target nick is not a registered client, THEN THE IRCd SHALL reply `401 ERR_NOSUCHNICK`, publish no `irc.invite` event and add no Invite record.

### Requirement 7: Invite records

**User Story:** As an operator, I want the server to remember whom I invited, so that a later invite-only mode can use it.

#### Acceptance Criteria

1. WHEN the IRCd accepts an `INVITE`, THE ChannelRegistry SHALL add the target nick, keyed under rfc1459 case-mapping, to the channel's `invited` set.
2. WHEN a client joins a channel, THE ChannelRegistry SHALL remove that client's nick from the channel's `invited` set.
3. WHEN the last member leaves a channel and the channel is removed, THE ChannelRegistry SHALL discard the channel's `invited` set.
4. WHEN the same nick is invited twice to one channel, THE ChannelRegistry SHALL keep a single entry for the nick.
5. THE IRCd SHALL NOT change who may join a channel based on Invite records, because mode `+i` is not implemented.
6. WHEN nicks that differ only by case or by rfc1459-equivalent characters (for example `[` and `{`) are invited to one channel, THE ChannelRegistry SHALL keep a single shared entry for them.
7. WHEN a client whose nick is not in the channel's `invited` set joins the channel, THE ChannelRegistry SHALL leave the `invited` set unchanged.
8. WHEN a channel is created again after removal, THE ChannelRegistry SHALL start it with an empty `invited` set.

### Requirement 8: Host normalization

**User Story:** As a client author, I want every nick!user@host prefix to be valid, so that no host or parameter starts with `:` and breaks parsing.

#### Acceptance Criteria

1. WHEN a peer address begins with `::ffff:` (compared ASCII case-insensitively) and the remainder is a dotted-quad IPv4 address, THE normalizeHost function SHALL return the remainder, so that `::ffff:127.0.0.1` becomes `127.0.0.1`.
2. WHEN a peer address begins with `:` after Criterion 1 is applied, THE normalizeHost function SHALL return the address with `0` prepended, so that `::1` becomes `0::1`.
3. WHEN a peer address is a plain IPv4 address or an IPv6 address that does not begin with `:`, THE normalizeHost function SHALL return the address unchanged.
4. WHEN a peer address is undefined, THE normalizeHost function SHALL return undefined.
5. WHEN a TCP connection is accepted, THE TCP transport SHALL pass the peer address through normalizeHost before the address becomes `client.host`.
6. WHEN a WebSocket connection is accepted, THE WebSocket transport SHALL pass the peer address through normalizeHost before the address becomes `client.host`.
7. THE IRCd SHALL use one normalizeHost implementation for both transports.
8. FOR ALL peer addresses, applying normalizeHost to its own output SHALL return the same value (idempotence property).
9. FOR ALL dotted-quad IPv4-mapped peer addresses and all other IPv6 and IPv4 peer addresses, the normalizeHost output SHALL NOT begin with `:`, and for dotted-quad IPv4-mapped input the output SHALL NOT contain `::ffff:` (output-shape property).
10. WHEN a peer address begins with `::ffff:` and the remainder is not a dotted-quad IPv4 address, THE normalizeHost function SHALL return the address with `0` prepended, so that `::ffff:abcd:1234` becomes `0::ffff:abcd:1234`.
11. WHEN a peer address is the empty string, THE normalizeHost function SHALL return the empty string.

### Requirement 9: Reflected input in error numerics is clamped

**User Story:** As a user, I want error replies to arrive even when I typed a very long nick or channel, so that no reply vanishes silently.

#### Acceptance Criteria

1. WHEN the IRCd sends `401`, `403`, `441`, `442`, `443` or `482` that reflects user-supplied text, THE IRCd SHALL cut each reflected parameter at the nearest preceding UTF-8 code point boundary so the serialized reply is within the line limit, producing neither a partial character nor a replacement character.
2. THE IRCd SHALL apply Criterion 1 to every existing handler that sends `401`, `403`, `441`, `442`, `443` or `482`, and to the handlers added by this spec.
3. WHEN a reflected parameter already fits, THE IRCd SHALL send a reply that is byte-for-byte identical to the unclamped reply.
4. WHEN a reflected parameter is cut, THE IRCd SHALL send the clamped reply, keep the client's connection open and log nothing at error level.
5. THE IRCd SHALL reuse `clampTrailing` or a shared helper built on it, and SHALL NOT add a second truncation implementation.

### Requirement 10: NetworkClient destroy timer

**User Story:** As an operator, I want a closing connection to leave no stray timer, so that the server shuts down cleanly.

#### Acceptance Criteria

1. WHEN `close(reason)` is called on a network client whose wire is already destroyed, THE NetworkClient SHALL mark the client closed, NOT call `end()` and NOT arm the destroy timer.
2. WHEN `close(reason)` is called on a network client whose wire is not destroyed and that is not yet closed, THE NetworkClient SHALL send an ERROR line carrying the reason, mark the client closed, call `end()` once on the wire, and arm exactly one destroy timer of `closeGraceMs`.
3. WHEN `close(reason)` is called on a network client that is already closed, THE NetworkClient SHALL do nothing further, call `end()` no second time and leave the existing destroy timer in place.
4. WHEN the wire is destroyed during the Grace period, THE NetworkClient SHALL cancel the pending destroy timer.
5. WHEN the Grace period elapses and the wire is not destroyed, THE NetworkClient SHALL call `destroy()` once on the wire and hold no pending destroy timer.

### Requirement 11: Numerics and documentation

**User Story:** As a maintainer, I want the new numerics named in one place and documented, so that handlers never use string literals.

#### Acceptance Criteria

1. THE `@seance/irc-protocol` package SHALL export `RPL_WHOISIDLE` with the value `317` and `RPL_WHOISSPECIAL` with the value `320` in `Numerics`.
2. THE IRCd SHALL reference every numeric used by this spec through the `Numerics` constants, with no string-literal numerics in the `AWAY`, `WHOIS` and `INVITE` handlers under `apps/ircd/src/handlers`.
3. WHEN this spec is implemented, THE README SHALL list `AWAY`, `WHOIS` and `INVITE` among the supported commands and state `AWAYLEN=200`.
4. WHERE the README lists supported numerics, THE README SHALL list `317` and `320` among them.
