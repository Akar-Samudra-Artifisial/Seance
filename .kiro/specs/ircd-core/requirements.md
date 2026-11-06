# Requirements Document

## Introduction

`ircd-core` is the M1 milestone of Séance: a minimal IRC server implementing a subset of RFC 2812 over TCP and WebSocket. The exit criterion for M1 is that two irssi clients can register, join a channel and chat. Agent integration (the ACP runner) is out of scope for this spec, but the server must expose a `VirtualClient` interface so agents can later connect in-process.

## Glossary

- **IRCd:** the IRC server implemented by this spec; the system under test and the subject of every requirement.
- **Client:** any connection to the IRCd over TCP, WebSocket or the in-process virtual client interface.
- **Registered client:** a client that has completed `PASS`/`NICK`/`USER` registration.
- **Channel operator:** a member with mode `+o` in a channel.
- **Voiced member:** a member with mode `+v` in a channel.
- **Moderated channel:** a channel with mode `+m` set.
- **Peer:** relative to a client, any other client that shares at least one channel with it.
- **Line:** one IRC message terminated by CRLF, at most 512 bytes including CRLF measured in UTF-8.
- **Line limit:** the 512-byte maximum length of a line, including the terminating CRLF, measured in UTF-8 bytes.
- **Idle interval:** the configured duration of client inactivity after which the IRCd sends a keep-alive `PING`; defaults to 120 seconds of no data received.
- **Ping timeout:** the configured duration within which a client must answer a server `PING`; defaults to 60 seconds.

---

## Requirements

### Requirement 1: Message framing and parsing

**User Story:** As a client author, I want the IRCd to follow the IRC wire format, so that standard clients like irssi and HexChat work unchanged.

#### Acceptance Criteria

1. WHEN the IRCd receives bytes on a connection, THE IRCd SHALL split the bytes into lines on CRLF, accept a bare LF as a line terminator, and discard any resulting empty line without sending a reply.
2. IF a received line exceeds 512 bytes including the terminating CRLF, measured in UTF-8 bytes, THEN THE IRCd SHALL discard the line, send `417 ERR_INPUTTOOLONG` to the client, and keep the connection open.
3. WHEN the IRCd sends a message, THE IRCd SHALL terminate the message with exactly one CRLF.
4. WHEN the IRCd sends a message, THE IRCd SHALL keep the message within 512 bytes including the terminating CRLF, measured in UTF-8 bytes.
5. IF a received line does not conform to the message grammar or carries more than 15 parameters, THEN THE IRCd SHALL ignore the line, send no reply, and keep the connection open.
6. IF a registered client sends an unknown command, THEN THE IRCd SHALL reply with `421 ERR_UNKNOWNCOMMAND`.
7. WHEN the IRCd matches an incoming command name, THE IRCd SHALL match the command name using ASCII case-insensitive comparison.

### Requirement 2: Transports

**User Story:** As a user, I want to connect with either a classic IRC client or the web client, so that humans on any client are peers.

#### Acceptance Criteria

1. THE IRCd SHALL accept IRC connections over plain TCP on a configurable port that defaults to 6667.
2. THE IRCd SHALL accept IRC connections over WebSocket, where each text frame carries zero or more complete lines.
3. WHEN a message arrives over any transport, THE IRCd SHALL process the message with the same parser and command router and produce identical parse and routing results regardless of transport.
4. WHEN a WebSocket text frame ends with an incomplete line, THE IRCd SHALL buffer the partial line and complete it when the remaining bytes arrive in a later frame.
5. WHEN a transport connection closes, THE IRCd SHALL process the closure as a `QUIT` with a reason describing the closure.

### Requirement 3: Registration (PASS / NICK / USER)

**User Story:** As an operator, I want connections to authenticate and register, so that only authorised users can join.

#### Acceptance Criteria

1. IF a server password is configured AND a client sends `NICK` and `USER` without a matching prior `PASS`, THEN THE IRCd SHALL reply `464 ERR_PASSWDMISMATCH` and close the connection.
2. IF a client that has already completed registration sends `PASS`, THEN THE IRCd SHALL reply `462 ERR_ALREADYREGISTRED` and SHALL leave the client's existing registration state unchanged.
3. IF a client sends `NICK` with a nickname already in use under rfc1459 case-mapping, THEN THE IRCd SHALL reply `433 ERR_NICKNAMEINUSE`.
4. IF a client sends `NICK` with a nickname that is empty, exceeds 30 characters, or contains any character outside the set of letters, digits, and the characters `-`, `[`, `]`, `\`, `` ` ``, `^`, `{`, `}`, `_`, or that begins with a character other than a letter, THEN THE IRCd SHALL reply `432 ERR_ERRONEUSNICKNAME`.
5. IF a client sends `NICK` without a nickname parameter, THEN THE IRCd SHALL reply `431 ERR_NONICKNAMEGIVEN`.
6. IF a client sends a command with fewer parameters than the command requires, THEN THE IRCd SHALL reply `461 ERR_NEEDMOREPARAMS`.
7. IF an unregistered client sends a command other than `PASS`, `NICK`, `USER`, `PING`, `PONG` or `QUIT`, THEN THE IRCd SHALL reply `451 ERR_NOTREGISTERED`.
8. IF a client that has already completed registration sends `USER`, THEN THE IRCd SHALL reply `462 ERR_ALREADYREGISTRED` and SHALL leave the client's existing registration state unchanged.
9. WHEN a client has supplied a valid `NICK`, a valid `USER`, and (where a server password is configured) a matching `PASS`, THE IRCd SHALL send, in this order, numerics `001`, `002`, `003`, `004` and `005`, followed by the MOTD numerics `375`, `372` and `376`.
10. WHEN a registered client changes its nickname, THE IRCd SHALL broadcast the `NICK` change to the client and to every peer of the client.

### Requirement 4: Keep-alive (PING / PONG)

**User Story:** As an operator, I want dead connections detected, so that stale users do not linger in channels.

#### Acceptance Criteria

1. WHEN a client sends `PING <token>`, THE IRCd SHALL reply `PONG <server> :<token>`.
2. IF a client sends `PING` without a token parameter, THEN THE IRCd SHALL reply `461 ERR_NEEDMOREPARAMS`.
3. WHILE a client has received no complete message for the idle interval, THE IRCd SHALL send a `PING` to the client.
4. IF a client does not answer a server `PING` within the ping timeout, THEN THE IRCd SHALL close the connection with reason `Ping timeout`.

### Requirement 5: Channels (JOIN / PART)

**User Story:** As a user, I want to join and leave channels, so that each task has its own room.

#### Acceptance Criteria

1. WHEN a registered client sends `JOIN #name` for a channel that does not exist, THE IRCd SHALL create the channel and grant the joining client `+o`.
2. WHEN a client joins a channel, THE IRCd SHALL broadcast `JOIN` to every member of the channel including the joining client.
3. WHEN a client joins a channel, THE IRCd SHALL send the joining client the topic (`332 RPL_TOPIC` or `331 RPL_NOTOPIC`) and the names (`353 RPL_NAMREPLY` followed by `366 RPL_ENDOFNAMES`).
4. IF a client sends `JOIN` for a channel name that does not begin with `#`, THEN THE IRCd SHALL reply `403 ERR_NOSUCHCHANNEL`.
5. WHEN a client sends `JOIN` for a channel of which it is already a member, THE IRCd SHALL make no change and send no reply for that channel.
6. IF a client sends `PART #name` for a channel the client is not in, THEN THE IRCd SHALL reply `442 ERR_NOTONCHANNEL`.
7. WHEN a client parts a channel, THE IRCd SHALL broadcast `PART` with the optional reason to all members of the channel, including the leaver.
8. WHEN the last member leaves a channel, THE IRCd SHALL remove the channel and discard its topic and mode state.
9. WHEN a client sends `JOIN` or `PART` with multiple comma-separated channels, THE IRCd SHALL process each channel in listed order, and a failure on one channel SHALL NOT prevent processing of the remaining channels.
10. IF a client sends `JOIN` or `PART` with no channel parameter, THEN THE IRCd SHALL reply `461 ERR_NEEDMOREPARAMS`.

### Requirement 6: Messaging (PRIVMSG / NOTICE)

**User Story:** As a user, I want to talk in channels and privately, so that I can instruct the team or one member.

#### Acceptance Criteria

1. WHEN a registered client that is a member of `#ch` and is permitted to speak in `#ch` sends `PRIVMSG #ch :text`, THE IRCd SHALL relay `:nick!user@host PRIVMSG #ch :text` to every member of `#ch` except the sender.
2. WHEN a registered client sends `PRIVMSG nick :text` to an existing nick, THE IRCd SHALL relay `:sender!user@host PRIVMSG nick :text` only to the client named `nick`.
3. IF a client sends `PRIVMSG` to a nick that does not exist, THEN THE IRCd SHALL reply `401 ERR_NOSUCHNICK` and SHALL NOT deliver the message.
4. IF a client sends `PRIVMSG` to a channel that does not exist, THEN THE IRCd SHALL reply `403 ERR_NOSUCHCHANNEL` and SHALL NOT deliver the message.
5. IF a client that is not a member sends `PRIVMSG` to a channel, THEN THE IRCd SHALL reply `404 ERR_CANNOTSENDTOCHAN` and SHALL NOT deliver the message.
6. IF a moderated channel receives `PRIVMSG` from a member that has neither `+o` nor `+v`, THEN THE IRCd SHALL reply `404 ERR_CANNOTSENDTOCHAN` and SHALL NOT deliver the message.
7. IF a client sends `PRIVMSG` with a target but an empty or absent text parameter, THEN THE IRCd SHALL reply `412 ERR_NOTEXTTOSEND` and SHALL NOT deliver the message.
8. IF a client sends `PRIVMSG` with no target parameter, THEN THE IRCd SHALL reply `411 ERR_NORECIPIENT` and SHALL NOT deliver the message.
9. IF a `NOTICE` cannot be delivered for any reason, THEN THE IRCd SHALL suppress every error reply for that `NOTICE`.
10. WHEN a registered client that is permitted to send to the target sends `NOTICE <target> :text`, THE IRCd SHALL relay `:sender!user@host NOTICE <target> :text` to the target using the same delivery rules as `PRIVMSG`.
11. WHEN a client sends `PRIVMSG nick :text` to a client that is marked away, THE IRCd SHALL reply to the sender with `301 RPL_AWAY` and SHALL still deliver the message to the away client.

### Requirement 7: Topic

**User Story:** As an operator, I want to set a channel topic, so that it states the task for everyone.

#### Acceptance Criteria

1. WHEN a member sends `TOPIC #ch` with no topic text and channel `#ch` exists, THE IRCd SHALL reply `332 RPL_TOPIC` with the current topic if a topic is set, or `331 RPL_NOTOPIC` if no topic is set.
2. WHEN a channel operator sends `TOPIC #ch :text`, THE IRCd SHALL replace the channel topic with `text` and relay the message `:nick!user@host TOPIC #ch :text` to all members of `#ch` including the sender.
3. IF a non-operator member sends `TOPIC #ch :text`, THEN THE IRCd SHALL reply `482 ERR_CHANOPRIVSNEEDED` and SHALL NOT change the channel topic.
4. IF a non-member sends `TOPIC #ch` or `TOPIC #ch :text` for an existing channel `#ch`, THEN THE IRCd SHALL reply `442 ERR_NOTONCHANNEL` and SHALL NOT change the channel topic.
5. IF a member sends a `TOPIC` command naming a channel that does not exist, THEN THE IRCd SHALL reply `403 ERR_NOSUCHCHANNEL`.
6. IF a `TOPIC` command is sent with no channel parameter, THEN THE IRCd SHALL reply `461 ERR_NEEDMOREPARAMS`.

### Requirement 8: NAMES and LIST

**User Story:** As a user, I want to see who is in a channel and which channels exist, so that I can find the right task.

#### Acceptance Criteria

1. WHEN a client sends `NAMES` for an existing channel, THE IRCd SHALL reply with one or more `353 RPL_NAMREPLY` lines listing every member, prefixing each channel operator with `@` and each voiced member with `+` and no prefix for members with neither mode, followed by a single `366 RPL_ENDOFNAMES`.
2. IF a client sends `NAMES` for a channel that does not exist or has no members, THEN THE IRCd SHALL reply with `366 RPL_ENDOFNAMES` for that channel name and SHALL NOT emit any `353 RPL_NAMREPLY` line.
3. WHEN a `353 RPL_NAMREPLY` reply would exceed 512 bytes including the trailing CRLF measured in UTF-8, THE IRCd SHALL split the member list across multiple `353` lines so that each emitted line is at most 512 bytes including CRLF, without splitting any individual nick across two lines.
4. WHEN a client sends `LIST` with no channel parameter, THE IRCd SHALL reply with one `322 RPL_LIST` line per visible channel carrying the channel name, the visible member count as a non-negative integer, and the channel topic, followed by a single `323 RPL_LISTEND`.
5. WHEN a client sends `LIST` and no visible channels exist, THE IRCd SHALL reply with `323 RPL_LISTEND` and SHALL NOT emit any `322 RPL_LIST` line.

### Requirement 9: Channel modes (+o / +v / +m)

**User Story:** As an operator, I want to grant and revoke permissions with modes, so that I control who may speak and who may write.

#### Acceptance Criteria

1. WHEN a channel operator sends `MODE #ch +o nick` or `MODE #ch -o nick` for an existing channel where `nick` is a member, THE IRCd SHALL set (for `+o`) or clear (for `-o`) the named member's operator flag and broadcast to every channel member a `MODE` message whose origin prefix is the requesting operator and whose mode arguments are `+o nick` or `-o nick` respectively.
2. WHEN a channel operator sends `MODE #ch +v nick` or `MODE #ch -v nick` for an existing channel where `nick` is a member, THE IRCd SHALL set (for `+v`) or clear (for `-v`) the named member's voice flag and broadcast to every channel member a `MODE` message whose origin prefix is the requesting operator and whose mode arguments are `+v nick` or `-v nick` respectively.
3. WHEN a channel operator sends `MODE #ch +m` or `MODE #ch -m` for an existing channel, THE IRCd SHALL set (for `+m`) or clear (for `-m`) the channel moderated flag and broadcast to every channel member a `MODE` message whose origin prefix is the requesting operator and whose mode argument is `+m` or `-m` respectively.
4. WHEN a member sends `MODE #ch` for an existing channel with no mode change argument, THE IRCd SHALL reply `324 RPL_CHANNELMODEIS` containing the channel's currently active channel modes.
5. IF a mode change targets a channel name that does not exist, THEN THE IRCd SHALL reply `403 ERR_NOSUCHCHANNEL` and SHALL make no change to any channel or member flag.
6. IF the sender of a mode change is not a channel operator of the named existing channel, THEN THE IRCd SHALL reply `482 ERR_CHANOPRIVSNEEDED` and SHALL make no change to any channel or member flag.
7. IF a channel operator sends an `+o`, `-o`, `+v`, or `-v` mode change with no target nick parameter, THEN THE IRCd SHALL reply `461 ERR_NEEDMOREPARAMS` and SHALL make no change to any channel or member flag.
8. IF a mode change uses a mode character other than `o`, `v`, or `m`, THEN THE IRCd SHALL reply `472 ERR_UNKNOWNMODE` and SHALL make no change to any channel or member flag.
9. IF a mode change names a target nick that is not a member of the named existing channel, THEN THE IRCd SHALL reply `441 ERR_USERNOTINCHANNEL` and SHALL make no change to any channel or member flag.
10. WHEN the IRCd successfully applies a mode change, THE IRCd SHALL publish a mode-change event identifying the channel, the affected mode, and any target member for other components.

### Requirement 10: KICK

**User Story:** As an operator, I want to kick a member, so that I can hard-stop a misbehaving agent.

#### Acceptance Criteria

1. WHEN a channel operator sends `KICK #ch nick :reason`, THE IRCd SHALL broadcast `KICK` to all members including the target, and SHALL then remove the target from the channel, using the kicker's nickname as the reason when no reason parameter is supplied.
2. IF a member that is not a channel operator sends `KICK #ch nick`, THEN THE IRCd SHALL reply `482 ERR_CHANOPRIVSNEEDED` and SHALL NOT remove the target.
3. IF the kick target is not in the channel, THEN THE IRCd SHALL reply `441 ERR_USERNOTINCHANNEL`.
4. WHEN the IRCd removes the kicked target from the channel, THE IRCd SHALL publish a kick event so that the agent runner can cancel the session.
5. IF a client sends `KICK` naming a channel that does not exist, THEN THE IRCd SHALL reply `403 ERR_NOSUCHCHANNEL`.
6. IF a client that is not a member of the channel sends `KICK` for that channel, THEN THE IRCd SHALL reply `442 ERR_NOTONCHANNEL`.
7. IF a client sends `KICK` with fewer than two parameters, THEN THE IRCd SHALL reply `461 ERR_NEEDMOREPARAMS`.

### Requirement 11: QUIT

**User Story:** As a user, I want to disconnect cleanly, so that others see I have left.

#### Acceptance Criteria

1. WHEN a client sends `QUIT` with a reason parameter, THE IRCd SHALL broadcast a `QUIT` message carrying that reason exactly once to every peer of the client, excluding the quitting client.
2. WHEN a client sends `QUIT` without a reason parameter, THE IRCd SHALL broadcast a `QUIT` message carrying the reason `Client Quit` exactly once to every peer of the client, excluding the quitting client.
3. WHEN a client sends `QUIT`, THE IRCd SHALL remove the client from every channel of which it is a member before closing the connection.
4. WHEN the IRCd has broadcast a client's `QUIT` to all peers and removed it from all channels, THE IRCd SHALL close the client's connection.
5. WHEN a client's connection is closed following a `QUIT`, THE IRCd SHALL release the client's nickname, making it available under rfc1459 case-mapping for reuse by a subsequent `NICK`.

### Requirement 12: Virtual clients

**User Story:** As the agent runner, I want to connect agents in-process, so that agents and humans share one source of truth.

#### Acceptance Criteria

1. THE IRCd SHALL expose a `VirtualClient` interface that sends parsed `IrcMessage` objects and delivers each server message directed to the virtual client to a registered handler, one `IrcMessage` per invocation, without a socket.
2. WHEN a virtual client sends a command, THE IRCd SHALL route the command through the same command router and permission checks as network clients and produce the same numerics and broadcasts that a network client would receive for identical input and channel state.
3. THE IRCd SHALL present virtual clients to peers identically to network clients across JOIN, PART, QUIT, MODE, PRIVMSG and NOTICE broadcasts, `353 RPL_NAMREPLY`, WHOIS output, and `@`/`+` prefixes, so that no peer can distinguish a virtual client from a network client.
4. IF a virtual client submits an `IrcMessage` that is malformed or whose serialized form would exceed 512 bytes including CRLF measured in UTF-8, THEN THE IRCd SHALL reject the message through the same boundary validation as network input, SHALL NOT route it, and SHALL indicate the rejection to the caller.
