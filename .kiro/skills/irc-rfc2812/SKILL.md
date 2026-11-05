---
name: irc-rfc2812
description: Cheat sheet for the RFC 2812 subset Séance implements — message grammar, registration, commands (JOIN, PART, PRIVMSG, NOTICE, TOPIC, NAMES, LIST, MODE, KICK, INVITE, WHOIS, AWAY) and the exact numeric reply formats. Use when implementing or testing ircd handlers, numerics, or the protocol package.
---

# IRC RFC 2812 subset for Séance

Authoritative behavior lives in `.kiro/specs/ircd-core/requirements.md`. This is a quick reference for wire formats.

## Message grammar

```
message  = [ ":" prefix SPACE ] command [ params ] CRLF
prefix   = servername / ( nick [ "!" user ] [ "@" host ] )
command  = 1*letter / 3digit
params   = *14( SPACE middle ) [ SPACE ":" trailing ]
```

- Max 512 bytes including CRLF (UTF-8 bytes). Max 15 params.
- Numeric replies: `:<server> <NNN> <target-nick> <params…>`; target is `*` before registration.
- User prefix for relayed messages: `:nick!user@host`.

## Registration

Client sends `PASS <password>` (optional, first), `NICK <nick>`, `USER <user> 0 * :<realname>`. On success the server sends:

| Numeric | Name | Format |
|---|---|---|
| 001 | RPL_WELCOME | `:Welcome to the Séance IRC Network <nick>!<user>@<host>` |
| 002 | RPL_YOURHOST | `:Your host is <servername>, running version <ver>` |
| 003 | RPL_CREATED | `:This server was created <date>` |
| 004 | RPL_MYINFO | `<servername> <version> <usermodes> <chanmodes>` (e.g. `seance 0.1 a mov`) |
| 005 | RPL_ISUPPORT | `CHANTYPES=# PREFIX=(ov)@+ CHANMODES=,,,m CASEMAPPING=rfc1459 NICKLEN=… :are supported by this server` |
| 375/372/376 | RPL_MOTDSTART / RPL_MOTD / RPL_ENDOFMOTD | `:- <server> Message of the day -`, `:- Server is haunted`, `:End of MOTD command` |

`PING :<token>` → `PONG <server> :<token>`.

## Commands and replies

| Command | Success | Errors |
|---|---|---|
| `JOIN #ch` | relay `:n!u@h JOIN #ch` to all members, then `332`/`331`, `353`…`366` to joiner | `403`, `461` |
| `PART #ch [:msg]` | relay `PART` to members | `403`, `442`, `461` |
| `PRIVMSG <target> :text` | relay to target(s) except sender; `301` if target user is away | `401`, `403`, `404`, `411`, `412` |
| `NOTICE <target> :text` | relay; **never** produces an error reply | — |
| `TOPIC #ch [:topic]` | query → `332`/`331`; set → relay `TOPIC` to members | `442`, `482`, `461` |
| `NAMES #ch` | `353` (split if > 512 bytes), then `366` | — |
| `LIST` | `322` per channel, then `323` | — |
| `MODE #ch [+o/-o/+v/-v nick] [+m/-m]` | query → `324`; change → relay `MODE` | `403`, `441`, `472`, `482` |
| `KICK #ch nick [:reason]` | relay `KICK` to members, target removed | `403`, `441`, `442`, `482` |
| `INVITE nick #ch` | `341` to inviter, `INVITE` to target | `401`, `442`, `443`, `482` |
| `WHOIS nick` | `311`, `319`, `312`, `301`?, `317`?, then `318` | `401`, `431` |
| `AWAY [:msg]` | `306` set / `305` unset | — |
| `QUIT [:msg]` | relay `QUIT` once to each peer, close | — |

## Reply formats

| Numeric | Name | Params after target |
|---|---|---|
| 301 | RPL_AWAY | `<nick> :<away message>` |
| 305 | RPL_UNAWAY | `:You are no longer marked as being away` |
| 306 | RPL_NOWAWAY | `:You have been marked as being away` |
| 311 | RPL_WHOISUSER | `<nick> <user> <host> * :<realname>` |
| 312 | RPL_WHOISSERVER | `<nick> <server> :<server info>` |
| 317 | RPL_WHOISIDLE | `<nick> <seconds> :seconds idle` |
| 318 | RPL_ENDOFWHOIS | `<nick> :End of WHOIS list` |
| 319 | RPL_WHOISCHANNELS | `<nick> :{[@\|+]#channel }` |
| 322 | RPL_LIST | `<#ch> <visible count> :<topic>` |
| 323 | RPL_LISTEND | `:End of LIST` |
| 324 | RPL_CHANNELMODEIS | `<#ch> <+modes> [mode params]` |
| 331 | RPL_NOTOPIC | `<#ch> :No topic is set` |
| 332 | RPL_TOPIC | `<#ch> :<topic>` |
| 341 | RPL_INVITING | `<#ch> <nick>` |
| 353 | RPL_NAMREPLY | `= <#ch> :[@\|+]nick [@\|+]nick …` |
| 366 | RPL_ENDOFNAMES | `<#ch> :End of NAMES list` |
| 401 | ERR_NOSUCHNICK | `<nick> :No such nick/channel` |
| 403 | ERR_NOSUCHCHANNEL | `<#ch> :No such channel` |
| 404 | ERR_CANNOTSENDTOCHAN | `<#ch> :Cannot send to channel` |
| 411 | ERR_NORECIPIENT | `:No recipient given (<command>)` |
| 412 | ERR_NOTEXTTOSEND | `:No text to send` |
| 417 | ERR_INPUTTOOLONG | `:Input line was too long` |
| 421 | ERR_UNKNOWNCOMMAND | `<command> :Unknown command` |
| 431 | ERR_NONICKNAMEGIVEN | `:No nickname given` |
| 432 | ERR_ERRONEUSNICKNAME | `<nick> :Erroneous nickname` |
| 433 | ERR_NICKNAMEINUSE | `<nick> :Nickname is already in use` |
| 441 | ERR_USERNOTINCHANNEL | `<nick> <#ch> :They aren't on that channel` |
| 442 | ERR_NOTONCHANNEL | `<#ch> :You're not on that channel` |
| 443 | ERR_USERONCHANNEL | `<nick> <#ch> :is already on channel` |
| 451 | ERR_NOTREGISTERED | `:You have not registered` |
| 461 | ERR_NEEDMOREPARAMS | `<command> :Not enough parameters` |
| 462 | ERR_ALREADYREGISTRED | `:Unauthorized command (already registered)` |
| 464 | ERR_PASSWDMISMATCH | `:Password incorrect` |
| 472 | ERR_UNKNOWNMODE | `<char> :is unknown mode char to me for <#ch>` |
| 482 | ERR_CHANOPRIVSNEEDED | `<#ch> :You're not channel operator` |

`417` comes from IRCv3/modern servers, not RFC 2812; it is what clients expect today.

## Séance semantics on top of IRC

- `+o` = agent may write/shell/commit, `+v` = may speak, `+m` = only `+o`/`+v` may speak.
- `KICK` on an agent = ACP `session/cancel` + worktree reset; message `*** <nick> has been exorcised`.
- `WHOIS` on an agent adds model, tools and credits (as `320`-style free-text lines or `NOTICE`; decide in the agent-runner spec).
