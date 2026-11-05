---
inclusion: fileMatch
fileMatchPattern: ["apps/ircd/**", "packages/irc-protocol/**"]
---

# IRC Protocol Rules (ircd + irc-protocol)

Applies when editing the IRC server or the protocol package. The spec is `.kiro/specs/ircd-core/`; the command and numeric cheat sheet is the `irc-rfc2812` skill.

## Wire format

- Follow **RFC 2812** (client protocol). Implement only the subset listed in `DESIGN.md` §3 and the `ircd-core` spec; do not add commands speculatively.
- Every emitted line ends in **CRLF** (`\r\n`) and contains no other CR, LF or NUL. Accept a bare `\n` on input.
- A message is at most **512 bytes including CRLF**, counted in **UTF-8 bytes** (`Buffer.byteLength`), never `string.length`.
  - Inbound overlong line → discard and reply `417 ERR_INPUTTOOLONG`.
  - Outbound: `serialize()` throws instead of truncating silently; callers that build long replies (e.g. `353`) must split them.
- At most 15 parameters. Only the last parameter may contain spaces, start with `:`, or be empty; it is then prefixed with `:`.
- Commands are case-insensitive on input, upper-case on output. Nick/channel comparisons use `irc_lower` (rfc1459 case-mapping).

## Numerics

- Use the **standard numeric** for every reply/error (e.g. `001`–`005`, `353`/`366`, `401`, `403`, `404`, `433`, `441`, `442`, `461`, `482`). Never invent a numeric for a standard condition.
- Reference numerics through the named constants in `@seance/irc-protocol` (`Numerics.ERR_NICKNAMEINUSE`), not string literals.
- The first parameter of a numeric reply is the target nick (`*` before registration).
- `NOTICE` never triggers an error reply or an automatic response.

## One parser, many transports

- `packages/irc-protocol` is pure: no sockets, timers, `process`, or Node-specific I/O. It must stay runnable in the browser.
- TCP, WebSocket and in-process `VirtualClient` all go through the **same** `LineFramer` + `parse()` + `CommandRouter`. Never add a transport-specific parser or a shortcut that skips the router.
- A WebSocket text frame may contain several lines or a partial line; always feed frames through `LineFramer`.

## State and errors

- `apps/ircd` owns all IRC state (`ConnectionManager`, `ChannelRegistry`). Other packages act through a client, never by mutating state.
- A handler exception is caught per message, logged with command + client id, and never crashes the server.
- Every protocol change gets a unit test and, where it touches parse/serialize/framing, a fast-check property (see `testing.md`).
