# Requirements: ircd-core

## Introduction

`ircd-core` is the M1 milestone of Séance: a minimal IRC server implementing a subset of RFC 2812 over TCP and WebSocket. The exit criterion for M1 is that two irssi clients can register, join a channel and chat. Agent integration (ACP runner) is out of scope for this spec, but the server must expose a `VirtualClient` interface so agents can later connect in-process.

## Glossary

- **Client:** any connection (TCP, WebSocket or in-process virtual client).
- **Registered client:** a client that has completed `PASS`/`NICK`/`USER` registration.
- **Channel operator (op):** a member with mode `+o` in a channel.
- **Voiced member:** a member with mode `+v` in a channel.
- **Line:** one IRC message terminated by CRLF.

---

## Requirement 1: Message framing and parsing

**User story:** As a client author, I want the server to follow the IRC wire format, so that standard clients like irssi and HexChat work unchanged.

### Acceptance criteria

1. WHEN the server receives bytes on a connection THE SYSTEM SHALL split them into lines on CRLF, also accepting a bare LF.
2. WHEN a received line exceeds 512 bytes including CRLF THE SYSTEM SHALL discard it and send `417 ERR_INPUTTOOLONG` to the client.
3. WHEN the server sends a message THE SYSTEM SHALL terminate it with CRLF and SHALL NOT exceed 512 bytes including CRLF.
4. WHEN a line cannot be parsed THE SYSTEM SHALL ignore it without closing the connection.
5. WHEN a registered client sends an unknown command THE SYSTEM SHALL reply with `421 ERR_UNKNOWNCOMMAND`.
6. THE SYSTEM SHALL treat command names case-insensitively.

## Requirement 2: Transports

**User story:** As a user, I want to connect with either a classic IRC client or the web client, so that humans on any client are peers.

### Acceptance criteria

1. THE SYSTEM SHALL accept IRC connections over plain TCP on a configurable port (default 6667).
2. THE SYSTEM SHALL accept IRC connections over WebSocket, where each text frame carries one or more lines.
3. WHEN a message arrives over any transport THE SYSTEM SHALL process it with the same parser and command router.
4. WHEN a transport connection closes unexpectedly THE SYSTEM SHALL treat it as `QUIT` with a reason describing the closure.

## Requirement 3: Registration (PASS / NICK / USER)

**User story:** As an operator, I want connections to authenticate and register, so that only authorised users can join.

### Acceptance criteria

1. WHEN a server password is configured AND a client completes `NICK` and `USER` without a correct prior `PASS` THE SYSTEM SHALL reply `464 ERR_PASSWDMISMATCH` and close the connection.
2. WHEN a client sends `PASS` after registration THE SYSTEM SHALL reply `462 ERR_ALREADYREGISTRED`.
3. WHEN a client sends `NICK` with a nickname already in use (case-insensitive) THE SYSTEM SHALL reply `433 ERR_NICKNAMEINUSE`.
4. WHEN a client sends `NICK` with an invalid nickname THE SYSTEM SHALL reply `432 ERR_ERRONEUSNICKNAME`.
5. WHEN a client sends `NICK` without a parameter THE SYSTEM SHALL reply `431 ERR_NONICKNAMEGIVEN`.
6. WHEN a command is missing required parameters THE SYSTEM SHALL reply `461 ERR_NEEDMOREPARAMS`.
7. WHEN an unregistered client sends a command other than `PASS`, `NICK`, `USER`, `PING`, `PONG` or `QUIT` THE SYSTEM SHALL reply `451 ERR_NOTREGISTERED`.
8. WHEN a client completes registration THE SYSTEM SHALL send `001`–`004` followed by the MOTD (`375`, `372`, `376`).
9. WHEN a registered client changes its nickname THE SYSTEM SHALL broadcast the `NICK` change to the client and every user sharing a channel with it.

## Requirement 4: Keep-alive (PING / PONG)

**User story:** As an operator, I want dead connections detected, so that stale users do not linger in channels.

### Acceptance criteria

1. WHEN a client sends `PING <token>` THE SYSTEM SHALL reply `PONG <server> :<token>`.
2. WHEN a client has been idle for the configured interval THE SYSTEM SHALL send `PING`.
3. WHEN a client does not answer a server `PING` within the configured timeout THE SYSTEM SHALL close the connection with reason `Ping timeout`.

## Requirement 5: Channels (JOIN / PART)

**User story:** As a user, I want to join and leave channels, so that each task has its own room.

### Acceptance criteria

1. WHEN a registered client sends `JOIN #name` for a channel that does not exist THE SYSTEM SHALL create it and give the client `+o`.
2. WHEN a client joins a channel THE SYSTEM SHALL broadcast `JOIN` to all members and send the joiner the topic (`332` or `331`) and names (`353`, `366`).
3. WHEN a channel name is invalid THE SYSTEM SHALL reply `403 ERR_NOSUCHCHANNEL`.
4. WHEN a client sends `PART #name` for a channel it is not in THE SYSTEM SHALL reply `442 ERR_NOTONCHANNEL`.
5. WHEN a client parts a channel THE SYSTEM SHALL broadcast `PART` with the optional reason to all members including the leaver.
6. WHEN the last member leaves a channel THE SYSTEM SHALL remove the channel.
7. WHEN `JOIN` lists multiple comma-separated channels THE SYSTEM SHALL process each in order.

## Requirement 6: Messaging (PRIVMSG / NOTICE)

**User story:** As a user, I want to talk in channels and privately, so that I can instruct the team or one member.

### Acceptance criteria

1. WHEN a client sends `PRIVMSG #ch :text` and may speak in `#ch` THE SYSTEM SHALL deliver it to every other member of `#ch`.
2. WHEN a client sends `PRIVMSG nick :text` THE SYSTEM SHALL deliver it only to that user.
3. WHEN the target nick or channel does not exist THE SYSTEM SHALL reply `401 ERR_NOSUCHNICK` (nick) or `403 ERR_NOSUCHCHANNEL` (channel).
4. WHEN a client that is not a member sends to a channel THE SYSTEM SHALL reply `404 ERR_CANNOTSENDTOCHAN`.
5. WHEN a channel has `+m` AND the sender has neither `+o` nor `+v` THE SYSTEM SHALL reply `404 ERR_CANNOTSENDTOCHAN` and not deliver the message.
6. WHEN `PRIVMSG` has no text THE SYSTEM SHALL reply `412 ERR_NOTEXTTOSEND`; WHEN it has no target THE SYSTEM SHALL reply `411 ERR_NORECIPIENT`.
7. WHEN `NOTICE` fails for any reason THE SYSTEM SHALL NOT send any error reply.
8. WHEN a private target is away THE SYSTEM SHALL reply to the sender with `301 RPL_AWAY`.

## Requirement 7: Topic

**User story:** As an operator, I want to set a channel topic, so that it states the task for everyone.

### Acceptance criteria

1. WHEN a member sends `TOPIC #ch` THE SYSTEM SHALL reply with `332 RPL_TOPIC` or `331 RPL_NOTOPIC`.
2. WHEN a channel operator sends `TOPIC #ch :text` THE SYSTEM SHALL update the topic and broadcast `TOPIC` to all members.
3. WHEN a non-operator sets the topic THE SYSTEM SHALL reply `482 ERR_CHANOPRIVSNEEDED`.
4. WHEN a non-member queries or sets the topic THE SYSTEM SHALL reply `442 ERR_NOTONCHANNEL`.

## Requirement 8: NAMES and LIST

**User story:** As a user, I want to see who is in a channel and which channels exist, so that I can find the right task.

### Acceptance criteria

1. WHEN a client sends `NAMES #ch` THE SYSTEM SHALL reply with `353 RPL_NAMREPLY` lines prefixing ops with `@` and voiced members with `+`, followed by `366 RPL_ENDOFNAMES`.
2. WHEN a `353` reply would exceed 512 bytes THE SYSTEM SHALL split it across multiple `353` lines.
3. WHEN a client sends `LIST` THE SYSTEM SHALL reply with one `322 RPL_LIST` per channel (name, visible member count, topic) followed by `323 RPL_LISTEND`.

## Requirement 9: Channel modes (+o / +v / +m)

**User story:** As an operator, I want to grant and revoke permissions with modes, so that I control who may speak and who may write.

### Acceptance criteria

1. WHEN a channel operator sends `MODE #ch +o nick` or `-o nick` THE SYSTEM SHALL update the member's op flag and broadcast `MODE` to all members.
2. WHEN a channel operator sends `MODE #ch +v nick` or `-v nick` THE SYSTEM SHALL update the member's voice flag and broadcast `MODE`.
3. WHEN a channel operator sends `MODE #ch +m` or `-m` THE SYSTEM SHALL update the moderated flag and broadcast `MODE`.
4. WHEN a member sends `MODE #ch` without changes THE SYSTEM SHALL reply `324 RPL_CHANNELMODEIS`.
5. WHEN a non-operator attempts a mode change THE SYSTEM SHALL reply `482 ERR_CHANOPRIVSNEEDED`.
6. WHEN the mode target nick is not in the channel THE SYSTEM SHALL reply `441 ERR_USERNOTINCHANNEL`.
7. WHEN an unsupported mode character is used THE SYSTEM SHALL reply `472 ERR_UNKNOWNMODE`.
8. WHEN a mode change is applied THE SYSTEM SHALL publish a mode-change event for other components (e.g. the agent runner).

## Requirement 10: KICK

**User story:** As an operator, I want to kick a member, so that I can hard-stop a misbehaving agent.

### Acceptance criteria

1. WHEN a channel operator sends `KICK #ch nick :reason` THE SYSTEM SHALL broadcast `KICK` to all members and remove the target from the channel.
2. WHEN a non-operator sends `KICK` THE SYSTEM SHALL reply `482 ERR_CHANOPRIVSNEEDED`.
3. WHEN the target is not in the channel THE SYSTEM SHALL reply `441 ERR_USERNOTINCHANNEL`.
4. WHEN a member is kicked THE SYSTEM SHALL publish a kick event so that the agent runner can cancel the session.

## Requirement 11: QUIT

**User story:** As a user, I want to disconnect cleanly, so that others see I have left.

### Acceptance criteria

1. WHEN a client sends `QUIT :reason` THE SYSTEM SHALL broadcast `QUIT` once to every user sharing a channel with it, remove it from all channels, and close the connection.
2. WHEN a client quits THE SYSTEM SHALL release its nickname for reuse.

## Requirement 12: Virtual clients

**User story:** As the agent runner, I want to connect agents in-process, so that agents and humans share one source of truth.

### Acceptance criteria

1. THE SYSTEM SHALL expose a `VirtualClient` interface that sends parsed `IrcMessage` objects and receives server messages, without a socket.
2. WHEN a virtual client sends a command THE SYSTEM SHALL route it through the same command router and permission checks as network clients.
3. THE SYSTEM SHALL make virtual clients indistinguishable from network clients to other users.
