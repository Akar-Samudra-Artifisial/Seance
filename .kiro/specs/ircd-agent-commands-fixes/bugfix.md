# Bugfix Requirements Document

## Introduction

`ircd-agent-commands-fixes` is a bugfix spec for six findings from the review of `ircd-agent-commands` (`apps/ircd`, spec `.kiro/specs/ircd-agent-commands/`). Two are Major: invite records that leak (`channel-registry.ts:60,71`) and `WHOIS` replies that trust `whoisExtra()` output (`handlers/whois.ts:14-24,72`). The other four are an `AWAY` whitespace edge case (`handlers/away.ts:22`), an `irc.invite` event and `INVITE` reply that miss information the runner and inviter need (`handlers/invite.ts:98-116`), duplicated reply helpers (`away.ts:7`, `message.ts:25,38`, `registration.ts:10`), and TCP connection resets logged as errors (`tcp-transport.ts:86`). Nothing in `apps/runner` changes.

Every fix starts with a regression test that fails on the current code (`.kiro/steering/testing.md`). The invited-set invariant of Finding 1 is also covered by a fast-check property (at least 100 runs) in the design, and the spec ends with a checkpoint that runs `pnpm typecheck && pnpm test`.

### Glossary

- **IRCd:** the server in `apps/ircd`.
- **Invited set:** `Channel.invited`, a set of `irc_lower(nick)` keys per channel.
- **Resolver-claimed nick:** a nick that is not connected, was claimed by the `InviteResolver` (`ircd-agent-commands` Req 6.3), and stays recorded in the invited set until it joins or is displaced (user decision, unchanged).
- **INVITE-ACCEPTED:** an `INVITE` that passed every check in `ircd-agent-commands` Req 5.12 and Req 6.
- **Invited-set cap:** 100 entries per channel; when an invite would exceed it, the oldest entry is dropped.
- **Leave events:** `PART`, `KICK` (of the target) and `QUIT`.
- **Extra lines:** the value returned by a target's `whoisExtra()`.
- **Transient reset:** a socket error with code `ECONNRESET` or `EPIPE`.

### Semantics decided for invited entries

- **Leave events.** An invite for a channel is for a client that is not a member of it, so a leaving member normally has no entry there. An entry can exist only if the client was re-invited while a member (rejected with 443 today) or was placed there by an earlier flow. To keep the invariant simple and leak-free:
  - `PART` and `KICK` remove the leaving client's nick from the invited set of the channel it leaves. Invites to other channels stay, because the client is not a member there and may still accept them.
  - `QUIT` removes the quitting client's nick from the invited set of every channel, because the nick stops being a registered nick.
- **Resolver claims.** A resolver-claimed nick is not connected, so it cannot be told apart from a stale entry by connection state. It stays recorded until it joins, is displaced by the cap, or the channel is deleted. A connected client's entry never outlives the client.
- **NICK.** The entry is renamed only when the old nick was invited: the old key is removed in every channel that holds it, the new key is added in the same channel, and a single entry results if the new key was already present. A renamed entry never exceeds the cap. If the renaming client is a member of a channel, the new key is removed from that channel's invited set, so the "no current member" rule holds.
- **Re-invite.** Inviting a nick that is already in the set moves it to the newest position (it is the last to be dropped by the cap) and keeps a single entry.

### Invited-set invariant

For every sequence of `INVITE`, `JOIN`, `PART`, `QUIT`, `NICK` and `KICK` (including resolver claims), every channel's invited set satisfies all three conditions:

1. it has at most 100 entries;
2. it contains no current member of that channel;
3. every entry is either a currently registered nick or a resolver-claimed nick that has not joined since.

```pascal
FUNCTION isBugCondition_1(X)
  INPUT: X of type Sequence of {INVITE, JOIN, PART, QUIT, NICK, KICK}
  OUTPUT: boolean

  RETURN EXISTS channel C, state after X WHERE
         |C.invited| > 100
      OR EXISTS key IN C.invited: key IS key of a current member of C
      OR EXISTS key IN C.invited: key IS NOT a registered nick
         AND key IS NOT a resolver-claimed nick that has not joined since
END FUNCTION
```

---

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN an invited client sends `PART` or is kicked and the nick is still in the channel's invited set THEN the system leaves the entry in `channel.invited`, because `ChannelRegistry.part` (`channel-registry.ts`) never touches it.

1.2 WHEN a client with entries in the invited set of one or more channels quits THEN the system leaves the entries in every such channel, because `ChannelRegistry.removeClient` never touches `invited`, so a nick that is no longer registered stays recorded for as long as the channel lives.

1.3 WHEN a client with an entry in an invited set changes nick THEN the system keeps the old key and does not record the new nick, so a later `JOIN` as the new nick does not clear anything and the old key becomes stale. WHEN the new nick matches a stale or resolver-claimed key of a channel the client is a member of THEN the entry makes a current member appear in the invited set.

1.4 WHEN more than 100 invites accumulate for one channel THEN the system grows `channel.invited` without bound (`ChannelRegistry.invite`, `channel-registry.ts:71`), so an operator or a resolver-claimed flood can exhaust memory.

1.5 WHEN a target's `whoisExtra()` returns a value that is not an array (for example `undefined`, a string, or an object) THEN the system iterates it unchecked in `buildWhoisReplies` (`whois.ts:72`). WHEN an element is not a string THEN `stripControl` receives a non-string value and throws. In both cases the exception escapes to the `WHOIS` handler's outer `catch`, which logs it and sends none of the remaining replies, so the requester never receives `318 RPL_ENDOFWHOIS`.

1.6 WHEN `whoisExtra()` returns more than 10 strings THEN the system sends one `320` line for each, so a single `WHOIS` can emit an unbounded number of lines.

1.7 WHEN `whoisExtra()` throws and the failure is handled only around the call (`extraLines`, `whois.ts:14-24`) THEN the system guards that one call, yet any other exception while building the replies still drops `318`; the `318` is not guaranteed.

1.8 WHEN a registered client sends `AWAY` with text that is empty after `stripControl` and trimming (for example only spaces, tabs, or control characters) THEN the system sets the away text (`away.ts:22` tests the raw `text.length`) to the cleaned value, which is whitespace or an empty string, replies `306 RPL_NOWAWAY`, and later `PRIVMSG` and `WHOIS` produce a `301` with blank text. `VirtualClient.setAway` also does not trim, so whitespace-only text marks a virtual client away.

1.9 WHEN `INVITE` is accepted (`invite.ts:98-116`) THEN the system publishes `irc.invite` with only `channel`, `inviter`, `target` and `ts`, so the runner cannot tell whether the target is connected and must re-derive the case-mapped key itself.

1.10 WHEN `INVITE` is accepted for a connected target that has away text THEN the system replies only `341 RPL_INVITING` and does not reply `301 RPL_AWAY`, although RFC 2812 §3.2.7 requires the inviter to learn that the target is away.

1.11 WHEN `away.ts`, `message.ts` and `registration.ts` need to send a numeric or build a `nick!user@host` prefix THEN the system uses private copies of `numeric` (`away.ts:7`, `message.ts:25`, `registration.ts:10`) and `prefixOf` (`message.ts:38`) that duplicate `replies.ts`, so a fix in one copy does not reach the others.

1.12 WHEN a TCP socket reports `ECONNRESET` or `EPIPE` THEN the system logs it with `ctx.logger.error` (`tcp-transport.ts:86`), so ordinary client disconnects fill the error log.

### Expected Behavior (Correct)

2.1 WHEN a client leaves a channel by `PART` or is removed by `KICK` THEN the system SHALL remove the client's nick (`irc_lower`) from the invited set of that channel, and SHALL leave the invited sets of other channels unchanged.

2.2 WHEN a client quits THEN the system SHALL remove the client's nick from the invited set of every channel, including channels that the client was not a member of.

2.3 WHEN a registered client changes nick THEN the system SHALL, in every channel whose invited set holds the old key, remove the old key and add the new key (a single entry if the new key was already present, never above the cap), and SHALL leave channels without the old key unchanged. The system SHALL also remove the new key from the invited set of every channel the client is a member of. WHEN the old key was not invited THEN the system SHALL NOT add the new key.

2.4 WHEN an invite is recorded THEN the system SHALL keep at most 100 entries per channel, dropping the oldest entry first. WHEN the same nick is invited again THEN the system SHALL keep one entry and make it the newest.

2.5 WHEN `whoisExtra()` returns something that is not an array THEN the system SHALL send no `320` line for that target, log the problem with command `WHOIS`, the client id, the target id and the value type, and continue with the remaining replies.

2.6 WHEN `whoisExtra()` returns an array with non-string elements THEN the system SHALL skip each non-string element, log once, keep the string elements in order, and send a `320` for each kept element.

2.7 WHEN `whoisExtra()` returns more than 10 usable strings THEN the system SHALL send `320` for the first 10 in order and ignore the rest, applying the cap after non-string elements are skipped.

2.8 WHEN a registered target is answered by `WHOIS` THEN the system SHALL send exactly one `318 RPL_ENDOFWHOIS` last, even if `whoisExtra()` throws, returns a non-array, returns mixed types, or any other step of building the replies throws. The replies that were built before a failure SHALL still be sent, and the connection SHALL stay open.

2.9 WHEN `AWAY` text is empty after `stripControl` and trimming of leading and trailing whitespace THEN the system SHALL clear the away text and reply `305 RPL_UNAWAY`. WHEN the text is non-empty after trimming THEN the system SHALL store the trimmed text, clamped to AWAYLEN, and reply `306 RPL_NOWAWAY`. `VirtualClient.setAway` SHALL apply the same trim, so both paths agree.

2.10 WHEN `INVITE` is accepted THEN the system SHALL publish `irc.invite` with the existing fields plus `targetKey` (`irc_lower` of the target nick) and `targetOnline` (`true` when the target is a registered connected client, `false` for a resolver-claimed nick).

2.11 WHEN `INVITE` is accepted for a connected target with away text THEN the system SHALL send the inviter `341 RPL_INVITING` followed by exactly one `301 RPL_AWAY` for the target with the clamped away text. WHEN the target is not away, or is a resolver-claimed nick, THEN the system SHALL send no `301`.

2.12 WHEN `away.ts`, `message.ts` and `registration.ts` send a numeric or build a prefix THEN the system SHALL import `numeric` and `prefixOf` from `replies.ts` and SHALL NOT define local copies.

2.13 WHEN a TCP socket reports `ECONNRESET` or `EPIPE` THEN the system SHALL log it at debug level with the client id, destroy the socket, and not write an error entry. WHEN the error has any other code THEN the system SHALL keep logging at error level.

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a client joins a channel THEN the system SHALL CONTINUE TO remove the joiner's nick from that channel's invited set and leave other nicks unchanged (`ircd-agent-commands` Req 7.2, 7.7).

3.2 WHEN the last member leaves a channel THEN the system SHALL CONTINUE TO discard the channel and its invited set, and a recreated channel SHALL CONTINUE TO start with an empty set (Req 7.3, 7.8).

3.3 WHEN nicks that differ only by case or by rfc1459-equivalent characters are invited THEN the system SHALL CONTINUE TO keep one shared entry (Req 7.1, 7.4, 7.6).

3.4 WHEN the `InviteResolver` claims an unconnected nick THEN the system SHALL CONTINUE TO reply `341`, publish `irc.invite`, record the invite and send no `INVITE` message to any client, and the entry SHALL CONTINUE TO stay recorded until the nick joins (user decision, Req 6.3). The record SHALL CONTINUE TO NOT affect who may join a channel (Req 7.5).

3.5 WHEN `INVITE` is rejected THEN the system SHALL CONTINUE TO send exactly one error reply, no message to the target, no invite record, no `irc.invite` event and no `301`, in the check order of Req 5.12.

3.6 WHEN a target's `whoisExtra()` returns an array of up to 10 valid strings THEN the system SHALL CONTINUE TO send one `320` per string, in order, clamped to the line limit, between `312` and `301`/`317`, and SHALL CONTINUE TO call `whoisExtra()` exactly once per `WHOIS` (Req 3.2, 3.3, 3.5).

3.7 WHEN a target has no `whoisExtra()` or it returns an empty array THEN the system SHALL CONTINUE TO send no `320` and all other replies. WHEN the target is not registered THEN the system SHALL CONTINUE TO reply `401` then `318`. WHEN no nick is given THEN the system SHALL CONTINUE TO reply `431` and no `318` (Req 2.8, 2.9, 3.4).

3.8 WHEN `AWAY` carries non-empty text after trimming THEN the system SHALL CONTINUE TO store it clamped to AWAYLEN at a UTF-8 code point boundary and reply `306`. WHEN `AWAY` has no parameter THEN the system SHALL CONTINUE TO reply `305`. WHEN an unregistered client sends `AWAY` THEN the system SHALL CONTINUE TO reply `451` and change nothing (Req 1.1, 1.2, 1.8, 1.9).

3.9 WHEN a connected target without away text is invited THEN the system SHALL CONTINUE TO send `341` and the `INVITE` message to the target, and the existing `irc.invite` fields (`channel`, `inviter`, `target`, `ts`) SHALL CONTINUE TO have their current values (Req 5.1–5.3).

3.10 WHEN a message is sent to a nick with away text THEN the system SHALL CONTINUE TO reply exactly one `301` for `PRIVMSG` and none for `NOTICE` or channel messages (Req 1.4–1.6).

3.11 WHEN handlers send numerics and prefixes THEN the system SHALL CONTINUE TO emit byte-for-byte the same lines as before the refactor, including `001`–`005`, `306`, `305` and relayed `PRIVMSG`/`NOTICE` prefixes.

3.12 WHEN a TCP socket reports any error other than `ECONNRESET` or `EPIPE` THEN the system SHALL CONTINUE TO log it at error level, and WHEN any socket error occurs THEN the system SHALL CONTINUE TO destroy the socket and release the connection slot on `close`.

3.13 WHEN a client changes nick and is not in any invited set THEN the system SHALL CONTINUE TO announce the `NICK` change to the client and its channel peers once (`ircd-core` Req 3.10).
