# Requirements Document

## Introduction

`web-client-basic` is the M2 web client of Séance: a retro, keyboard-first, 1995-style IRC client that runs entirely in the browser (`apps/web`). The browser connects straight to the ircd WebSocket listener (default `ws://127.0.0.1:6680`, one IRC line per text frame). It has no IRC proxy and no API routes; the only server-side code on requests is the Next.js 16 request proxy (`proxy.ts`), which sets the Content-Security-Policy header with a per-request nonce. Humans and agents are peers on the same protocol, so the client must work against the real ircd and the agent runner.

The client is built from a pure, framework-free IRC client core (`apps/web/src/irc`) and thin UI components over a Zustand store. Visual source of truth is `.kiro/steering/web-ui.md` and the Figma frames `00 Style guide` (token reference), `01 Main`, `02 Connect`, `03 Kick` and `04 Whois+Options`.

Figma frames in scope for M2: `01 Main`, `02 Connect`, `03 Kick` and the Whois panel of `04 Whois+Options` (without the Options dialog and model picker). Figma frames out of scope for M2 (deferred to M3): `05 Channel list`, `06 Classic`, and the Options part of `04 Whois+Options`.

Out of scope for this spec (deferred to M3): CRT scanlines, the Options dialog and model picker, a channel list window (`/list` output goes to the status window), DCC, scrollback search, persistent logs, the jack-o'-lantern ASCII art, and multi-server support.

## Glossary

- **Web_Client**: the browser application in `apps/web`; the system under specification.
- **IRC_Core**: the pure, framework-free module in `apps/web/src/irc` containing the Connection_Machine, the Reducer, the Command_Parser and the Formatter. It performs no I/O, no timers and no DOM access.
- **Connection_Machine**: the state machine inside the IRC_Core that tracks the connection phase (`disconnected`, `connecting`, `registering`, `registered`, `failed`).
- **Reducer**: the pure function in the IRC_Core that maps the current client state and one parsed IRC message to the next client state.
- **Command_Parser**: the function in the IRC_Core that converts one input line typed by the user into an IRC command to send, a local action, or a raw line.
- **Formatter**: the function in the IRC_Core that converts IRC message text containing control codes into a list of styled Spans.
- **Span**: one run of visible text with style attributes (foreground colour, background colour, bold, underline).
- **Store**: the Zustand store that holds the client state and exposes actions to the UI components.
- **Ircd**: the Séance IRC server (`apps/ircd`) reached over WebSocket.
- **Protocol_Package**: `@seance/irc-protocol`, which provides `parse`, `serialize`, `LineFramer` and the `Numerics` constants.
- **Connect_Dialog**: the modal dialog that collects nick, server URL and optional password and starts a connection.
- **Window**: an MDI child window of one of three kinds: Status_Window, Channel_Window or Query_Window.
- **Status_Window**: the Window that shows MOTD, server notices, numerics and unrouted output.
- **Channel_Window**: the Window bound to one IRC channel; it contains the Topic_Bar, the Chat_Buffer and the Nick_List.
- **Query_Window**: the Window bound to one private conversation with another nick.
- **Active_Window**: the Window that currently has focus and receives typed input.
- **Switchbar**: the bar listing one button per open Window.
- **Topic_Bar**: the bar at the top of a Channel_Window showing the channel topic.
- **Chat_Buffer**: the scrollable list of rendered lines in a Window.
- **Nick_List**: the list of channel members shown at the right of a Channel_Window.
- **Input_Line**: the single-line text field at the bottom of the client where the user types messages and commands.
- **Mention**: a line from another user whose text contains the own nick as a whole word, compared with rfc1459 case-mapping.
- **Tool_Notice**: a `NOTICE` from an agent whose text starts with `using tool:` or `ops:` and contains `denied`.
- **Known_Agent**: one of the three agent nicks `coder`, `reviewer` and `researcher`, compared with rfc1459 case-mapping; the same set as the agent nick colour tokens in `web-ui.md`.
- **Fake_Agent**: the scripted stand-in for `kiro-cli` at `apps/runner/test/fixtures/fake-kiro`, used by the end-to-end test.
- **Paste_Queue**: the Store-owned queue that holds the lines of a multi-line paste until they are sent, one line per 500 ms.
- **Paste_Confirmation**: the prompt shown in the Status_Window when a paste holds more than 5 lines, which the user answers to send or cancel the paste.
- **Raw_Command**: a slash command that is not in the list of Requirement 7 criterion 4 and is sent as a raw line.
- **CSP**: the Content-Security-Policy response header sent with every production response of the Web_Client.
- **Connect_Src**: the set of origins permitted by the `connect-src` directive of the CSP: `'self'`, the origin of `NEXT_PUBLIC_IRCD_WS_URL`, and in development also `ws://127.0.0.1:6680`.
- **Request_Proxy**: the Next.js 16 `proxy.ts` file (the replacement for `middleware.ts`) that sets the CSP and its per-request nonce on responses; it handles headers only and carries no IRC traffic.
- **Allowed_Origins**: the Ircd setting `IRCD_WS_ALLOWED_ORIGINS` listing the web origins permitted to open a WebSocket.
- **E2E_Test**: the opt-in Playwright test that drives the Web_Client against an in-process Ircd with the runner and the Fake_Agent.

---

## Requirements

### Requirement 1: Technology stack and project setup

**User Story:** As a developer, I want `apps/web` set up with the agreed stack and workspace scripts, so that the client builds and tests like every other package.

#### Acceptance Criteria

1. THE Web_Client SHALL be a package named `@seance/web` in `apps/web` using Next.js 16, React, Tailwind CSS 4, Zustand 5 and TypeScript in strict mode with ESM only.
2. THE `@seance/web` package SHALL declare exact dependency versions and a `tsconfig.json` that extends `tsconfig.base.json` without loosening any compiler option.
3. THE `@seance/web` package SHALL provide the scripts `dev`, `build`, `typecheck`, `test` and `lint`.
4. THE root Turborepo pipeline SHALL run the `build`, `typecheck`, `test` and `lint` scripts of `@seance/web` together with the other workspace packages.
5. THE Web_Client SHALL contain no Next.js API routes, no route handlers and no server-side proxy for IRC traffic; the only request-level server code SHALL be the Request_Proxy, which sets response headers and forwards no IRC traffic.
6. THE Web_Client SHALL load fonts IBM Plex Mono, Arimo and VT323 through `next/font` or self-hosted files, with no runtime request to a font CDN.
7. THE project documentation SHALL state Next.js 16 in `DESIGN.md` section 11 in place of Next.js 15.
8. THE Web_Client SHALL contain the word "mIRC" in none of its UI text, metadata, alt text or assets.

### Requirement 2: Browser-safe protocol package

**User Story:** As a developer, I want the web client to reuse `@seance/irc-protocol`, so that the browser and the Ircd parse and serialise IRC lines identically.

#### Acceptance Criteria

1. THE Web_Client SHALL use `parse`, `serialize`, `LineFramer` and `Numerics` from the Protocol_Package for all IRC line handling.
2. THE Protocol_Package SHALL execute in a browser without a Node.js global, a Node.js built-in module import or a bundler polyfill.
3. WHEN the Web_Client is built with `next build`, THE build SHALL complete with no Node.js polyfill configured for the Protocol_Package.
4. THE Protocol_Package SHALL expose its entry points as ESM that the Next.js bundler resolves from the workspace.
5. WHEN a WebSocket text frame arrives, THE Web_Client SHALL pass the frame through a `LineFramer` before parsing, so that frames holding several lines or a partial line produce the same messages as the same bytes delivered in any other chunking.
6. WHEN the Web_Client sends an IRC message, THE Web_Client SHALL produce the line with `serialize` and send exactly one line per WebSocket text frame.

### Requirement 3: Connection lifecycle

**User Story:** As a user, I want to connect to the Ircd from the browser, so that I can chat with humans and agents.

#### Acceptance Criteria

1. THE Web_Client SHALL open a connection only to the WebSocket server URL entered in the Connect_Dialog, defaulting to the value of `NEXT_PUBLIC_IRCD_WS_URL` and otherwise to `ws://127.0.0.1:6680`.
2. IF the origin of the entered server URL is not in the Connect_Src, THEN THE Connect_Dialog SHALL show an inline error that names the allowed origins and SHALL NOT open a connection.
3. THE Web_Client SHALL expose the allowed WebSocket origins of the Connect_Src to the Connect_Dialog at runtime in the browser.
4. WHEN the user submits the Connect_Dialog with a valid nick and server URL, THE Connection_Machine SHALL move from `disconnected` to `connecting` and open the WebSocket.
5. WHEN the WebSocket opens, THE Web_Client SHALL send `PASS` (only when a password was entered), then `NICK`, then `USER` and the Connection_Machine SHALL move to `registering`.
6. WHEN the Web_Client receives `001 RPL_WELCOME`, THE Connection_Machine SHALL move to `registered` and the Web_Client SHALL hide the Connect_Dialog.
7. IF the nick entered in the Connect_Dialog is not a valid IRC nick under the rules of the Ircd (1 to 30 characters, starts with a letter, letters, digits and `-[]\`^{}_` only), THEN THE Connect_Dialog SHALL show an inline error and SHALL NOT open a connection.
8. WHEN the Web_Client receives `433 ERR_NICKNAMEINUSE` while `registering`, THE Connect_Dialog SHALL show an inline error stating that the nick is in use and SHALL remain open for another nick.
9. WHEN the Web_Client receives `432 ERR_ERRONEUSNICKNAME` or `464 ERR_PASSWDMISMATCH` while `registering`, THE Connect_Dialog SHALL show an inline error stating the reason from the numeric.
10. IF the WebSocket fails to open or closes before `001`, THEN THE Connection_Machine SHALL move to `failed` and THE Connect_Dialog SHALL show an inline error describing the failure and offering a Reconnect button.
11. WHEN the WebSocket closes after `registered`, THE Connection_Machine SHALL move to `disconnected`, THE Status_Window SHALL show a line stating that the connection closed, and THE Web_Client SHALL show a Reconnect button.
12. WHEN the user activates the Reconnect button, THE Web_Client SHALL start a new connection with the last entered nick, server URL and password held in memory.
13. WHEN the Web_Client receives `PING <token>`, THE Web_Client SHALL reply `PONG :<token>` without showing the exchange in any Window.
14. WHEN the user quits, THE Web_Client SHALL send `QUIT` and then close the WebSocket.
15. WHEN the connection is re-established after a disconnect, THE Web_Client SHALL discard channel membership and Nick_List data from the previous connection and keep each Window's Chat_Buffer.

### Requirement 4: Credential and preference storage

**User Story:** As a user, I want my nick and server remembered but not my password, so that reconnecting is quick and credentials stay safe.

#### Acceptance Criteria

1. WHEN a connection reaches `registered`, THE Web_Client SHALL write the nick and server URL to `localStorage`.
2. THE Web_Client SHALL keep the `PASS` value only in memory and SHALL write it to no storage, URL, cookie or log.
3. WHEN the Connect_Dialog opens, THE Connect_Dialog SHALL prefill nick and server URL from `localStorage` when stored values exist and pass validation.
4. IF a value read from `localStorage` fails validation, or a stored server URL has an origin outside the Connect_Src, THEN THE Connect_Dialog SHALL ignore the value and use the default.
5. THE Web_Client SHALL write no chat content to `localStorage`.

### Requirement 5: Windows, MDI and switchbar

**User Story:** As a user, I want one window per status, channel and query, so that I can follow several conversations.

#### Acceptance Criteria

1. WHEN the connection reaches `registered`, THE Web_Client SHALL show a Status_Window containing the MOTD, server notices and numerics received so far.
2. WHEN the Web_Client receives a `JOIN` for the own nick, THE Web_Client SHALL open a Channel_Window for that channel and make the window the Active_Window.
3. WHEN the Web_Client receives a `PRIVMSG` or `NOTICE` addressed to the own nick from a nick with no open Query_Window, THE Web_Client SHALL open a Query_Window for that nick without changing the Active_Window.
4. WHEN the user runs `/query <nick>` or `/msg <nick>` with text, THE Web_Client SHALL open a Query_Window for that nick and make it the Active_Window.
5. WHEN the Web_Client receives a `PART` or `KICK` for the own nick in a channel, THE Web_Client SHALL close that Channel_Window, keep its text in memory for later reopening during the session, and make the Status_Window the Active_Window when the closed Window was active.
6. WHEN the user closes a Query_Window, THE Web_Client SHALL remove the window from the Switchbar.
7. THE Web_Client SHALL render each Window as an MDI child with a Win95 title bar using the chrome and active-title-gradient tokens from `web-ui.md`, showing the window name and a close control.
8. THE Switchbar SHALL show one button per open Window, mark the Active_Window, and mark a Window with unread lines.
9. WHEN the user activates a Switchbar button or the title bar of a Window, THE Web_Client SHALL make that Window the Active_Window and clear its unread marker.
10. WHEN the user presses `Alt+n` for n from 1 to 9, THE Web_Client SHALL make the nth Window in Switchbar order the Active_Window.
11. WHEN the user presses `Esc` while a dialog is open, THE Web_Client SHALL close the dialog and return focus to the Input_Line.
12. WHEN a line arrives in a Window that is not the Active_Window, THE Web_Client SHALL mark that Window as unread, and WHEN the line is a Mention, THE Web_Client SHALL mark that Window as mentioned.
13. THE Chat_Buffer of each Window SHALL retain at most 1000 lines and SHALL discard the oldest lines first.

### Requirement 6: Channel window content

**User Story:** As a user, I want a channel window with timestamps, topic and member list, so that I can see who is here and what is said.

#### Acceptance Criteria

1. THE Chat_Buffer SHALL prefix each line with a `[HH:MM]` timestamp in the local time zone of the browser.
2. WHEN the Web_Client receives `332 RPL_TOPIC` or a `TOPIC` message, THE Topic_Bar SHALL show the new topic as text.
3. WHEN the Web_Client receives `331 RPL_NOTOPIC`, THE Topic_Bar SHALL show a placeholder stating that no topic is set.
4. WHEN the Web_Client receives `353 RPL_NAMREPLY` entries for a channel, THE Reducer SHALL add each entry as a member with the prefix `@` mapped to operator and `+` mapped to voiced, and the Nick_List SHALL show the members.
5. THE Nick_List SHALL sort members with operators first, then voiced members, then other members, and sort members alphabetically under rfc1459 case-mapping within each group.
6. THE Nick_List SHALL show the prefix `@` before each operator nick and `+` before each voiced nick.
7. WHEN the Web_Client receives `JOIN`, `PART`, `QUIT`, `KICK`, `NICK` or `MODE` affecting a channel member, THE Reducer SHALL update the member set of the affected channels before the next render.
8. WHEN the Web_Client receives `MODE <channel> +o <nick>`, `-o`, `+v` or `-v`, THE Reducer SHALL set or clear the operator or voiced flag of that member and THE Chat_Buffer SHALL show a line describing the mode change.
9. WHEN the Web_Client receives `NICK` for a user, THE Reducer SHALL rename that user in every channel and open Query_Window of the user, comparing nicks with rfc1459 case-mapping.
10. WHEN the Web_Client receives `QUIT` for a user, THE Reducer SHALL remove the user from every channel and THE Chat_Buffer of each affected Channel_Window SHALL show a quit line with the reason.
11. THE Nick_List SHALL show the member count of the channel.

### Requirement 7: Input line and slash commands

**User Story:** As a user, I want to type text and slash commands, so that I can drive channels and agents with IRC semantics.

#### Acceptance Criteria

1. WHEN the user submits text that does not start with `/` while a Channel_Window or Query_Window is the Active_Window, THE Command_Parser SHALL produce a `PRIVMSG` to the target of that Window.
2. IF the user submits text that does not start with `/` while the Status_Window is the Active_Window, THEN THE Web_Client SHALL show a local line in the Status_Window stating that no channel or query is active and SHALL send nothing.
3. WHEN the user submits `//text`, THE Command_Parser SHALL produce a `PRIVMSG` whose text is `/text`.
4. WHEN the user submits `/join <channel>[ <key>]`, `/part [<channel>][ <reason>]`, `/msg <target> <text>`, `/topic [<channel>][ <text>]`, `/invite <nick>[ <channel>]`, `/kick <nick>[ <reason>]`, `/mode <target>[ <modes>[ <args>]]`, `/whois <nick>`, `/names [<channel>]`, `/list`, `/away [<text>]`, `/nick <nick>` or `/quit [<reason>]`, THE Command_Parser SHALL produce the corresponding IRC message with the command in upper case.
5. WHEN the user submits `/join` with a channel name that has no leading `#`, THE Command_Parser SHALL prepend `#`.
6. WHEN the user submits `/part`, `/topic`, `/invite`, `/kick` or `/names` without a channel argument while a Channel_Window is the Active_Window, THE Command_Parser SHALL use the channel of that Window.
7. WHEN the user submits `/me <text>`, THE Command_Parser SHALL produce a `PRIVMSG` to the Active_Window target with the text wrapped as a CTCP ACTION (`\x01ACTION <text>\x01`).
8. WHEN the user submits `/query <nick>` without text, THE Command_Parser SHALL produce a local action that opens a Query_Window and SHALL send nothing.
9. WHEN the user submits a slash command not listed in this requirement, THE Command_Parser SHALL produce the raw line with the command name in upper case and the remaining arguments unchanged.
10. IF the user submits a known command with missing required arguments, THEN THE Command_Parser SHALL produce a local error line naming the command and its usage and SHALL send nothing.
11. IF a produced line would exceed 512 bytes including CRLF, measured in UTF-8 bytes, THEN THE Web_Client SHALL show a local error line stating the byte limit and SHALL send nothing.
12. FOR ALL command results that are IRC messages, serialising the message and then parsing the line SHALL produce an equivalent message (round-trip property).
13. THE Command_Parser SHALL produce no line that contains CR, LF or NUL, and THE Web_Client SHALL strip none of these characters silently from any submission.
14. IF the user submits text that contains NUL, THEN THE Command_Parser SHALL produce a local error line stating that NUL is not allowed and THE Web_Client SHALL send nothing from that submission.
15. IF the user submits a Raw_Command that contains CR, LF or NUL, THEN THE Command_Parser SHALL produce a local error line naming the command and stating that control characters are not allowed, and THE Web_Client SHALL send nothing.
16. IF the user submits text that contains a line break (CR, LF or CRLF) and whose first line starts with a single `/`, THEN THE Command_Parser SHALL produce a local error line stating that commands must be a single line, and THE Web_Client SHALL send nothing.
17. WHEN the user submits text that contains line breaks and passes criteria 14 and 16, THE Command_Parser SHALL split the text on CRLF, LF and CR into separate lines, discard empty lines, and produce one `PRIVMSG` per remaining line to the target of the Active_Window with the line text unchanged and never interpreted as a slash command.
18. WHEN a paste holds 1 to 5 lines, THE Store SHALL place the resulting messages in the Paste_Queue and send them at a rate of one message per 500 ms, the first message at once.
19. IF a paste holds more than 5 lines, THEN THE Web_Client SHALL show a Paste_Confirmation in the Status_Window stating the line count, SHALL send nothing until the user confirms, and WHEN the user confirms, THE Store SHALL send at most the first 5 lines through the Paste_Queue and show a local line stating how many lines were dropped.
20. WHEN the user declines the Paste_Confirmation or the connection closes while the Paste_Queue holds messages, THE Store SHALL empty the Paste_Queue and show a local line stating how many messages were not sent.
21. THE Store SHALL own the timer of the Paste_Queue, and THE IRC_Core SHALL contain no timer for pacing.
22. FOR ALL submissions of arbitrary text, every line produced by the Command_Parser SHALL contain no CR, LF or NUL (no-control-line property).
23. WHEN the user presses `Up` or `Down` in the Input_Line, THE Web_Client SHALL replace the Input_Line content with the previous or next entry of the command history, holding at most 100 entries.
24. WHEN the user presses `Tab` in the Input_Line with a partial word, THE Web_Client SHALL complete the word with a matching nick of the Active_Window, and WHEN several nicks match, THE Web_Client SHALL cycle through the matches on repeated `Tab` presses.
25. WHEN the user completes a nick at the start of the Input_Line, THE Web_Client SHALL append `: ` after the nick.
26. WHEN the user submits a line, THE Web_Client SHALL show the own message in the Active_Window, because the Ircd does not echo `PRIVMSG` to the sender.

### Requirement 8: Message rendering

**User Story:** As a user, I want colours and styles rendered safely, so that agent output is readable and nothing in the chat can attack my browser.

#### Acceptance Criteria

1. WHEN message text contains `\x03` colour codes with foreground values 0 to 15 and an optional background, THE Formatter SHALL produce Spans with the matching colour from the 16-colour IRC palette.
2. WHEN message text contains `\x02` (bold), `\x1f` (underline) or `\x0f` (reset), THE Formatter SHALL toggle or reset the matching Span attributes.
3. WHEN message text contains `\x03` with no digits, THE Formatter SHALL reset foreground and background colour.
4. THE Formatter SHALL remove every other control character below 0x20 (except tab, which becomes a space) and the character 0x7f from the output text.
5. FOR ALL input strings, THE Formatter SHALL output Spans whose concatenated text equals the input with all formatting and control codes removed (no visible character is lost).
6. FOR ALL input strings, THE Formatter SHALL output Spans containing no character below 0x20 and no 0x7f.
7. THE Web_Client SHALL render all IRC-derived text (messages, nicks, topics, reasons, notices and numerics) as React text nodes and SHALL NOT use `dangerouslySetInnerHTML`, `innerHTML` or `eval`.
8. WHEN message text contains a URL starting with `http://` or `https://`, THE Web_Client SHALL render the URL as an anchor with `target="_blank"` and `rel="noopener noreferrer"`.
9. THE Web_Client SHALL render a URL with any scheme other than `http` or `https` (for example `javascript:` or `data:`) as plain text.
10. THE Web_Client SHALL colour nicks using the nick colour tokens from `web-ui.md`: `coder`, `reviewer` and `researcher` in their assigned colours and all other nicks in the human colour.
11. WHEN a `PRIVMSG` is a CTCP ACTION, THE Chat_Buffer SHALL show the line as `* <nick> <text>`.
12. WHEN the Web_Client receives a Tool_Notice, THE Chat_Buffer SHALL render the line with a style visually distinct from ordinary messages, and a denied-operation notice SHALL use a style distinct from a tool-use notice.
13. WHEN the Web_Client receives a `PART` whose reason matches `*** <nick> has been exorcised`, THE Chat_Buffer SHALL render the line with a highlighted style.
14. WHEN the Web_Client receives a `KICK` whose target is not a Known_Agent, THE Chat_Buffer SHALL render the line, including the kicked nick, the kicker and the reason, with a highlighted style.
15. WHEN a line is a Mention, THE Chat_Buffer SHALL render the line with the accent-orange mention highlight.
16. THE Web_Client SHALL define all colours as Tailwind theme tokens or CSS variables and SHALL NOT hardcode hex values in components.
17. THE Chat_Buffer and the Input_Line SHALL use IBM Plex Mono at 15px, and the chrome (menus, dialogs, buttons, Nick_List) SHALL use Arimo.
18. WHEN the Web_Client receives a `KICK` whose target is a Known_Agent, THE Chat_Buffer SHALL render the line in the same highlighted style as the exorcism line of criterion 13, with the text `*** <agent> has been exorcised by <kicker>`, followed by ` (<reason>)` (one space, an opening parenthesis, the reason, a closing parenthesis) only WHEN the reason of the `KICK` is non-empty after the Formatter has removed control codes, and with no suffix otherwise; THE Chat_Buffer SHALL take `<agent>` as the nick in the `KICK` target parameter exactly as the Ircd sent it, and SHALL take `<kicker>` and `<reason>` from the `KICK` prefix and trailing parameter, pass them through the Formatter and render them as plain text with no markup.

### Requirement 9: Server replies and WHOIS block

**User Story:** As a user, I want server numerics and WHOIS answers shown clearly, so that I can inspect agents and channels.

#### Acceptance Criteria

1. THE Status_Window SHALL show the MOTD lines (`372`), `RPL_WELCOME` through `RPL_MYINFO` text, server `NOTICE` lines and other numerics not routed to another Window.
2. WHEN the Web_Client receives `311`, `319`, `312`, `320`, `317` and `318` for the same nick, THE Reducer SHALL collect the replies and THE Active_Window SHALL show them as one grouped block when `318 RPL_ENDOFWHOIS` arrives.
3. IF the Web_Client receives `401 ERR_NOSUCHNICK` for a nick with a pending WHOIS, THEN THE Active_Window SHALL show the error in place of the block and discard the collected replies.
4. WHEN the Web_Client receives `/list` replies `322` and `323`, THE Status_Window SHALL show each channel with its member count and topic.
5. WHEN the Web_Client receives `353` and `366` in answer to a user-issued `/names`, THE Active_Window SHALL show the names as one line.
6. WHEN the Web_Client receives an error numeric (`4xx` or `5xx`) in answer to a user command, THE Active_Window SHALL show the numeric text as an error line.
7. WHEN the Web_Client receives `305 RPL_UNAWAY` or `306 RPL_NOWAWAY`, THE Active_Window SHALL show the reply text.
8. WHEN the Web_Client receives a `NOTICE` from a user or an agent addressed to the own nick, THE Web_Client SHALL show the notice in the Query_Window of the sender, and WHEN the sender is a server, in the Status_Window.
9. WHEN the Web_Client receives a `INVITE` for the own nick, THE Active_Window SHALL show a line naming the inviter and the channel.
10. WHEN the Web_Client receives an unknown message or numeric, THE Status_Window SHALL show the line as text and THE Web_Client SHALL continue to process later messages.

### Requirement 10: Mentions and notifications

**User Story:** As a user, I want my nick highlighted when someone calls me, so that I do not miss agent questions.

#### Acceptance Criteria

1. WHEN a `PRIVMSG` or `NOTICE` from another nick contains the own nick as a whole word under rfc1459 case-mapping, THE Reducer SHALL flag the line as a Mention.
2. THE Web_Client SHALL flag no line sent by the own nick as a Mention.
3. WHERE the user enables the mention sound, THE Web_Client SHALL play a short sound when a Mention arrives.
4. THE Web_Client SHALL disable the mention sound by default.
5. WHERE the user enables the mention sound, THE Web_Client SHALL start audio only after a user gesture, as the browser requires.

### Requirement 11: Pure IRC core and thin UI

**User Story:** As a maintainer, I want the IRC logic isolated from React, so that I can test it without a browser.

#### Acceptance Criteria

1. THE IRC_Core SHALL reside in `apps/web/src/irc` and import no React, Next.js, Zustand, DOM or Node.js module.
2. THE IRC_Core SHALL expose the Connection_Machine, the Reducer, the Command_Parser and the Formatter as pure functions or immutable-state transitions.
3. THE Reducer SHALL return a new state object and SHALL NOT mutate its input state or input message.
4. THE UI components SHALL hold no IRC state of their own and SHALL read client state from the Store and dispatch actions to the Store.
5. THE Store SHALL be the only module that owns the WebSocket, the `LineFramer` and timers.
6. IF the Reducer receives a parsed message of any shape (including unknown commands, missing parameters and empty prefixes), THEN THE Reducer SHALL return a valid state and SHALL NOT throw.
7. WHEN the Store receives a WebSocket frame that is not text, THE Store SHALL ignore the frame and write a diagnostic line to the Status_Window.
8. IF a line from the Ircd fails `parse`, THEN THE Store SHALL discard the line, write a diagnostic line to the Status_Window and continue.

### Requirement 12: Nick list consistency

**User Story:** As a user, I want the member list to be correct after any sequence of events, so that I can trust it for permissions.

#### Acceptance Criteria

1. FOR ALL sequences of `JOIN`, `PART`, `KICK`, `QUIT`, `NICK` and `MODE` messages, THE Reducer SHALL keep each channel's member set free of duplicate nicks under rfc1459 case-mapping.
2. FOR ALL sequences of `JOIN`, `PART`, `KICK`, `QUIT`, `NICK` and `MODE` messages, THE Reducer SHALL keep the member set of a channel equal to the set computed by a simple reference model of the same sequence.
3. WHEN the own nick leaves a channel by `PART` or `KICK`, THE Reducer SHALL drop the member set of that channel.
4. FOR ALL sequences of messages, THE Nick_List ordering function SHALL produce operators, then voiced members, then others, with no member missing or repeated.
5. WHEN the Web_Client receives `MODE` for a member who is not in the set, THE Reducer SHALL leave the member set unchanged.

### Requirement 13: Agent permission visibility

**User Story:** As an operator, I want to see who may act and what agents are doing, so that I can govern them with IRC modes.

#### Acceptance Criteria

1. THE Nick_List SHALL show `@` for agents with operator mode, `+` for agents with voice and no prefix for agents with no mode, using the same rules as for humans.
2. WHEN the Web_Client receives `MODE` granting or revoking `+o` or `+v` on an agent, THE Chat_Buffer SHALL show the change line and THE Nick_List SHALL update before the next render.
3. WHEN the Web_Client receives an agent `NOTICE` such as `using tool: edit src/auth.ts`, THE Chat_Buffer SHALL show the notice as a Tool_Notice.
4. WHEN the Web_Client receives an agent `AWAY` status through `301 RPL_AWAY` or a `WHOIS` reply `301`, THE WHOIS block SHALL show the away text.
5. WHEN the user issues `/kick <agent> [reason]` and the Ircd confirms it with a `KICK` message, THE Chat_Buffer SHALL show the exorcism line of Requirement 8 criterion 18 (`*** <agent> has been exorcised by <kicker>`, with ` (<reason>)` appended only when a reason is present) and THE Nick_List SHALL no longer contain the agent.

### Requirement 14: Accessibility

**User Story:** As a keyboard or screen-reader user, I want the client to be fully operable without a mouse, so that I can use it with assistive technology.

#### Acceptance Criteria

1. THE Web_Client SHALL meet WCAG 2.2 AA contrast ratios of 4.5:1 for body text and 3:1 for large text and UI component boundaries on both the chrome and ghost surfaces.
2. THE Chat_Buffer SHALL have `role="log"` and `aria-live="polite"`.
3. THE Web_Client SHALL show a visible focus indicator on every interactive element.
4. THE Web_Client SHALL make every action reachable by keyboard, including connect, switching Windows, closing Windows, sending input and activating the Reconnect button.
5. THE Connect_Dialog SHALL have `role="dialog"`, `aria-modal="true"`, a labelled title, labelled fields and inline errors linked to their fields with `aria-describedby`.
6. WHEN the Connect_Dialog opens, THE Web_Client SHALL move focus to the first empty field and SHALL return focus to the Input_Line when the dialog closes.
7. THE Nick_List SHALL expose a list role with an accessible name that includes the channel name and the member count.
8. THE Switchbar SHALL expose one button per Window with an accessible name that includes the Window name and any unread or mention state.
9. WHERE the browser reports `prefers-reduced-motion: reduce`, THE Web_Client SHALL disable animations and transitions.
10. THE Web_Client SHALL convey Tool_Notice, kick and mention states with a text marker as well as colour.

### Requirement 15: Security and robustness

**User Story:** As an operator, I want the client to treat all IRC input as untrusted, so that a hostile nick or message cannot attack the user.

#### Acceptance Criteria

1. THE Web_Client SHALL treat every IRC message, nick, topic, notice and tool output as untrusted data and SHALL display it only as text.
2. THE Web_Client SHALL never execute, evaluate or re-parse agent output as IRC commands or script.
3. THE Web_Client SHALL send a CSP header with every production response of a page.
4. IF a WebSocket frame exceeds 64 KiB, THEN THE Store SHALL close the connection and show an error line in the Status_Window.
5. WHILE the Chat_Buffer of a Window holds 1000 lines, THE Web_Client SHALL keep memory use per Window bounded by discarding the oldest line for each new line.
6. THE Web_Client SHALL read the default server URL from an environment variable prefixed `NEXT_PUBLIC_` and SHALL contain no hardcoded host, secret or credential beyond the documented local default `ws://127.0.0.1:6680`.
7. WHEN an unexpected error occurs while handling a message, THE Store SHALL show an error line naming the failed step and the message command, and SHALL continue to process later messages.
8. THE `script-src` directive of the CSP SHALL contain a nonce that differs for each response, and SHALL contain neither `'unsafe-inline'` nor `'unsafe-eval'` in production.
9. THE `connect-src` directive of the CSP SHALL contain exactly the Connect_Src: `'self'`, the origin of `NEXT_PUBLIC_IRCD_WS_URL`, and in development also `ws://127.0.0.1:6680`.
10. THE Request_Proxy SHALL set the CSP and its nonce, and SHALL set no other behaviour on IRC traffic.

### Requirement 16: Ircd WebSocket origin configuration

**User Story:** As an operator, I want to allow the web origin on the Ircd, so that browsers can connect while other origins are rejected.

#### Acceptance Criteria

1. THE project documentation SHALL describe `IRCD_WS_ALLOWED_ORIGINS`, its format (comma-separated origins), and the origin to set for local development (the Next.js dev server origin), and SHALL state that the origin of `NEXT_PUBLIC_IRCD_WS_URL` is the only non-local WebSocket origin that the CSP `connect-src` and the Connect_Dialog accept.
2. WHEN a browser opens a WebSocket from an origin that is not in the Allowed_Origins, THE Ircd SHALL refuse the upgrade.
3. WHEN a browser opens a WebSocket from an origin in the Allowed_Origins, THE Ircd SHALL accept the upgrade and process IRC lines.
4. IF the WebSocket upgrade is refused, THEN THE Connect_Dialog SHALL show an inline error that mentions the origin check as a possible cause.
5. THE `.env.example` or equivalent documentation SHALL list `NEXT_PUBLIC_IRCD_WS_URL` and `IRCD_WS_ALLOWED_ORIGINS` without secret values, and SHALL state that a change of `NEXT_PUBLIC_IRCD_WS_URL` changes the `connect-src` of the CSP.

### Requirement 17: Automated tests

**User Story:** As a maintainer, I want unit, property and end-to-end tests, so that regressions in the client core and the live flow are caught.

#### Acceptance Criteria

1. THE `@seance/web` package SHALL run unit and property tests with vitest and fast-check through `pnpm --filter @seance/web test`, with each test file next to its source file.
2. THE test suite SHALL include a property that the Reducer never throws on arbitrary parsed messages.
3. THE test suite SHALL include a property that the Reducer keeps each channel's member set equal to a reference model under arbitrary `JOIN`, `PART`, `KICK`, `QUIT`, `NICK` and `MODE` sequences.
4. THE test suite SHALL include a property that the Formatter never loses a visible character and never outputs a control code.
5. THE test suite SHALL include a property that the Command_Parser output, serialised and parsed, equals the produced message.
6. THE test suite SHALL include unit tests for the Connection_Machine transitions, the Formatter colour table, URL linkification, mention detection and the WHOIS block grouping.
7. THE test names for properties SHALL carry the identifiers of the properties in the design document of this spec.
8. THE unit and property tests SHALL open no network connection and use no wall-clock sleep.
9. THE project SHALL provide an opt-in script (`pnpm --filter @seance/web test:e2e`) that runs the E2E_Test and that `pnpm test` does not run.
10. WHEN the E2E_Test runs, THE E2E_Test SHALL start an in-process Ircd with the runner configured with `SEANCE_KIRO_BIN=apps/runner/test/fixtures/fake-kiro`, pass `FAKE_AGENT_SCRIPT` through the runner's child environment allow-list the way the Ircd integration tests do, and set `IRCD_WS_ALLOWED_ORIGINS` to the web origin.
11. WHEN the E2E_Test runs, THE E2E_Test SHALL connect from the browser, join a channel, invite `coder`, grant `+v`, send a message, and assert that a reply appears in the colour of the `coder` nick.
12. WHEN the E2E_Test runs, THE E2E_Test SHALL kick `coder` and assert that the highlighted line containing `has been exorcised by` and the kicker nick appears and `coder` leaves the Nick_List.
13. THE E2E_Test SHALL bind all servers to port 0 or a free port and close every process and socket after the test.
14. THE test suite SHALL include a property that no line produced by the Command_Parser from arbitrary submitted text contains CR, LF or NUL.
15. THE test suite SHALL include unit tests for multi-line paste splitting, the refusal of Raw_Commands containing CR, LF or NUL, the refusal of NUL, and the Paste_Confirmation for pastes of more than 5 lines.
16. THE unit tests for the Paste_Queue SHALL use fake timers to verify the 500 ms pacing, the immediate first message, and the emptying of the queue on decline or disconnect, with no real timer.
17. THE test suite SHALL include a test that a production response carries a CSP header whose `script-src` holds a nonce and neither `'unsafe-inline'` nor `'unsafe-eval'`, whose nonce differs between two responses, and whose `connect-src` equals the Connect_Src for the production configuration.
18. THE test suite SHALL include unit tests that the Connect_Dialog refuses a server URL with an origin outside the Connect_Src and ignores a stored server URL with an origin outside the Connect_Src.
19. THE test suite SHALL include unit tests for the KICK rendering of Requirement 8 criteria 14 and 18 covering: a Known_Agent kick with a reason (line ends with ` (<reason>)`), a Known_Agent kick without a reason (line has no suffix), a Known_Agent kick whose nick differs in case such as `Coder` (rendered as an exorcism line), a kick of a non-Known_Agent nick (rendered as the ordinary KICK highlight, not as an exorcism line), and a kicker or reason containing control codes (rendered as plain text with the control codes removed).

### Requirement 18: Documentation and Kiro usage log

**User Story:** As a hackathon participant, I want the work documented, so that the submission shows how Kiro was used.

#### Acceptance Criteria

1. THE project SHALL record the use of Kiro for this spec (spec creation, steering, agents, hooks used) in `docs/KIRO_USAGE.md`.
2. THE `apps/web` package SHALL include a README stating how to run the client against a local Ircd, the required `IRCD_WS_ALLOWED_ORIGINS` setting and how to run the unit tests and the E2E_Test.
3. THE project SHALL map the Figma frames `01 Main`, `02 Connect`, `03 Kick` and the Whois panel of `04 Whois+Options` to Web_Client components in the design document of this spec.
