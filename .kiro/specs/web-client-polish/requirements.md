# Requirements Document

## Introduction

`web-client-polish` brings the M2 web client (`apps/web`, spec `web-client-basic`) in line with the Figma mockup. The frames were read through the Talk-to-Figma channel `8p9g0i9k` (`get_node_info` and `export_node_as_image`):

| Frame | Node | What it fixes |
|---|---|---|
| `00 Style guide` | 1:4830 | Tokens: chrome, ghost palette, nick colours, 16 px icons, Win95 buttons, bevels, scrollbar, chat line types, typography (IBM Plex Mono 15/21 for chat, Arimo 12 for chrome, Arimo Bold for titles). |
| `01 Main` | 1:1093 | Title bar, menu bar, icon toolbar, topic bar, chat lines, nick list, input line, minimised-window tray, taskbar switchbar with credits counter, status bar. |
| `02 Status/MOTD` | 1:2153 | Status window line formats (numerics as `NNN text`, `-server-` notices, bold MOTD lines) and the title `Séance — [Status: <nick> (<umodes>) on <host>]`. |
| `03 Kick` | 1:4655 | Kick moment: exorcism line, struck-through agent in the nick list, MDI child title bar. |
| `04 Whois` | 1:2947 | WHOIS answer as classic lines with the nick as a bold prefix. The Agent Options dialog in this frame is out of scope. |

The Figma power (`get_design_context`) was not called: the file URL was not available when this spec was written (see Open Points in `design.md`). Frames `05 Channel list` and `06 Classic` are M3.

This spec changes presentation and adds the small amount of client state the new chrome needs (channel and user modes, lag, away flags, credits). It changes no protocol behaviour, no ircd behaviour and no security rule of `web-client-basic`: CSP with nonce, no inline `style` attribute, untrusted text only through `formatIrc`/`IrcText`, and the word "mIRC" nowhere.

Out of scope: the Options dialog and model picker, the channel list window, the Classic theme and the theme toggle behaviour (the button and label render, the toggle is disabled), CRT scanlines, floating decorative ghosts, the jack-o'-lantern art (it is plain MOTD text sent by the server).

## Glossary

- **Web_Client**, **Store**, **IRC_Core**, **Reducer**, **Window**, **Status_Window**, **Channel_Window**, **Query_Window**, **Active_Window**, **Switchbar**, **Topic_Bar**, **Chat_Buffer**, **Nick_List**, **Input_Line**, **Known_Agent**, **Formatter**: as in `web-client-basic`.
- **Title_Bar**: the top bar of the application with the app icon, the application title and the caption buttons.
- **Menu_Bar**: the Win95 menu bar below the Title_Bar.
- **Toolbar**: the 16 px icon toolbar below the Menu_Bar, with the theme label at its right end.
- **MDI_Child**: a Window shown inside the MDI area with its own child title bar (icon, title, minimise, maximise, close).
- **Minimised_Bar**: the compact bar of a minimised MDI_Child, placed in the Minimised_Tray above the Switchbar.
- **Minimised_Tray**: the row between the Input_Line and the Switchbar that holds the Minimised_Bars.
- **Credits_Counter**: the panel at the right end of the Switchbar showing the sum of agent credits seen in WHOIS answers.
- **Status_Bar**: the bottom bar with the panels connection, lag, agent counts.
- **Lag**: the round-trip time in seconds between a client `PING` and its `PONG`.
- **Event_Line**: a Chat_Buffer line for a join, part, quit, nick, mode, topic, kick or invite event, prefixed with `***`.
- **Exorcism_Line**: the Event_Line shown for a `KICK` of a Known_Agent.
- **Win95_Sans**: the Arimo font token (`font-chrome`) used for chrome text, menus, buttons and window titles.

---

## Requirements

### Requirement 1: Application title bar

**User Story:** As an operator, I want the browser client to show the window title like the mockup, so that I always see the channel, its modes and its topic.

#### Acceptance Criteria

1. THE Title_Bar SHALL show the app icon, the title text and the caption buttons minimise, maximise and close, in a 22 px bar with the active gradient (`title-from` to `title-to`), white Arimo Bold 12 text.
2. WHILE the Active_Window is a Channel_Window, THE Title_Bar text SHALL be `Séance — [<channel> (<modes>): <topic>]`, for example `Séance — [#fix-bug-123 (+mnt): Fix NPE on login when email is null]`.
3. WHILE the Active_Window is the Status_Window, THE Title_Bar text SHALL be `Séance — [Status: <nick> (<umodes>) on <host>]`; WHILE it is a Query_Window, `Séance — [<nick>]`.
4. WHEN the channel has no topic, THE Title_Bar SHALL omit `: <topic>`; WHEN the mode string is empty or only `+`, THE Title_Bar SHALL omit ` (<modes>)`; WHEN the user mode string is empty or only `+`, THE Title_Bar SHALL omit ` (<umodes>)`.
5. THE Title_Bar text SHALL render the topic through `IrcText` (control codes stripped, no markup) and SHALL be cut by CSS ellipsis, never wrapped.
6. WHILE a modal dialog is open, THE Title_Bar SHALL use the inactive style (grey gradient `title-inactive-from` to `title-inactive-to`).
7. THE document `<title>` SHALL be the same text as the Title_Bar.
8. THE caption buttons SHALL be real `button` elements with accessible names; minimise and maximise SHALL be disabled with `aria-disabled`, and close SHALL run the `quit` action after a confirm-free single activation only when the Store is connected, otherwise it SHALL do nothing.

### Requirement 2: Menu bar

**User Story:** As an operator, I want the Win95 menu bar with the classic menus, so that every existing action is reachable like in a 1995 client.

#### Acceptance Criteria

1. THE Menu_Bar SHALL show the menus File, View, Favorites, Tools, Commands, Window and Help, in this order, in Win95_Sans 12 px black on the chrome face, 20 px high, each with an underlined mnemonic letter.
2. THE Menu_Bar SHALL be keyboard accessible with `role="menubar"`, roving tabindex, `ArrowLeft`/`ArrowRight` between menus, `ArrowDown`/`Enter`/`Space` to open, `ArrowUp`/`ArrowDown` inside a menu, `Home`/`End`, `Escape` to close and return focus, and `Alt+<mnemonic>` to open a menu.
3. THE items SHALL map to existing commands only: File: Connect… (opens the Connect_Dialog), Reconnect, Close window, Quit. View: Mention sound (checkbox), Next window, Previous window. Tools: Whois of the selected nick. Commands: Join… , Part, Query…, Names, Topic…, Away, Back, Quit (each inserts or runs the matching slash command in the Input_Line through the Command_Parser). Window: one item per open window in Switchbar order with the active one checked, plus Close window. Help: Keyboard shortcuts (shows the existing `/help` text in the Status_Window).
4. THE menus Favorites and every item without an existing command (for example Options…, Channel list…, Favorites entries, Tools › Options) SHALL be rendered `aria-disabled="true"` with a disabled look, SHALL not be focus traps, and SHALL do nothing when activated.
5. WHEN an item needs an argument the Menu_Bar SHALL put the command prefix into the Input_Line (for example `/join #`) and move focus there, instead of opening a new dialog.
6. WHILE the Store is not `registered`, THE items that need a connection SHALL be disabled.
7. THE Menu_Bar SHALL contain no inline `style`, and its popups SHALL close on outside click and on `Escape`.
8. THE MDI child buttons (minimise, restore, close) of the active window SHALL appear at the right end of the Menu_Bar row as in the mockup.

### Requirement 3: Icon toolbar and theme label

**User Story:** As an operator, I want the icon toolbar from the mockup, so that common actions are one click away.

#### Acceptance Criteria

1. THE Toolbar SHALL be 32 px high and hold 26×24 px raised buttons with 16 px icons in the order: connect, separator, options, separator, channel list, agents, separator, logs, separator, theme toggle, matching the style guide icons.
2. Connect SHALL open the Connect_Dialog (or reconnect when a connection was made before); agents SHALL focus the Nick_List; logs SHALL show the Status_Window.
3. Options, channel list and the theme toggle SHALL be rendered disabled (`aria-disabled`, greyed icon) because their features are out of scope.
4. THE Toolbar SHALL show the text `Theme: Ghost` at its right end.
5. EVERY toolbar button SHALL have an accessible name and a `title` tooltip, and SHALL be reachable with `Tab`; the toolbar SHALL use `role="toolbar"` with arrow-key navigation.
6. THE icons SHALL be inline SVG or CSS-masked assets served from the app, with `aria-hidden`, no external request, and colours from theme tokens only.

### Requirement 4: MDI child windows

**User Story:** As an operator, I want windows with Win95 child title bars, so that the layout matches the mockup and windows can be minimised.

#### Acceptance Criteria

1. EVERY Window SHALL render inside an MDI_Child with a title bar (icon by window kind, title in Win95_Sans Bold 12, and minimise, maximise/restore, close buttons 16×14 px).
2. THE title of a Channel_Window SHALL be `<channel> [<modes>]: <topic>`, of the Status_Window `Status: <nick> on <host>`, of a Query_Window `<nick>`; the active window title bar SHALL use the active gradient and inactive ones the inactive style.
3. WHEN the user activates minimise, THE MDI_Child SHALL leave the MDI area and appear as a Minimised_Bar in the Minimised_Tray; WHEN the active window is minimised THE Store SHALL activate the next non-minimised window in Switchbar order, or the Status_Window.
4. WHEN the user activates a Minimised_Bar or its restore control, THE window SHALL become active and non-minimised.
5. WHEN the user activates maximise, THE window SHALL fill the MDI area (the default); restore SHALL return to the same state because the MDI area holds one visible window at a time.
6. Close SHALL keep its existing meaning (`closeWindow`); the Status_Window close button SHALL be disabled.
7. THE minimised flag SHALL be UI state of the Store, SHALL not affect line routing, unread or mention flags, and SHALL survive reconnect.
8. THE Minimised_Tray SHALL be hidden when no window is minimised.
9. ALL buttons SHALL have accessible names (`Minimise`, `Maximise`, `Close`), keyboard focus and no inline `style`.

### Requirement 5: Switchbar and Credits_Counter

**User Story:** As an operator, I want a taskbar-style switchbar, so that I can see all windows and the credits spent by my agents.

#### Acceptance Criteria

1. THE Switchbar SHALL be a 26 px row of 156×22 px raised buttons, one per window, each with a 12 px icon (status monitor, channel `#`, query ghost) and the window name in Win95_Sans 12.
2. THE active window button SHALL be sunken with bold text; a window with `unread` SHALL show its name in the link-blue token; a window with `mentioned` SHALL additionally show the accent orange.
3. Minimised windows SHALL stay in the Switchbar.
4. THE Credits_Counter SHALL sit at the right end of the Switchbar in a sunken panel with an orange dot and the text `credits: <n>` with one decimal, in IBM Plex Mono.
5. THE Credits_Counter SHALL equal the sum, over distinct agent nicks, of the latest `total` value parsed from a `320` WHOIS line of the form `credits: <channel> <used> / total <total>` seen in this session; a later answer for the same nick SHALL replace its earlier value.
6. WHEN no such line was seen, THE Credits_Counter SHALL show `credits: 0.0`.
7. THE parser SHALL accept only finite non-negative decimals, SHALL ignore any other `320` text, and SHALL treat the lines as untrusted text.
8. THE Credits_Counter SHALL have `role="status"` with an accessible name `Credits used by agents` and SHALL be cleared on a new connection to a different server.

### Requirement 6: Status bar

**User Story:** As an operator, I want the status bar from the mockup, so that I see the connection, the lag and the agent situation.

#### Acceptance Criteria

1. THE Status_Bar SHALL show four sunken panels: connection, lag, agent counts, and an empty filler.
2. WHILE `registered`, THE connection panel SHALL read `Connected to <host> as <nick>`, where `<host>` is the authority (host and port) of the connected server URL; WHILE the URL scheme is `wss`, THE panel SHALL append ` (TLS)`. In other phases it SHALL read the phase (`Connecting…`, `Disconnected`, `Connection failed`).
3. THE lag panel SHALL read `lag <s>s` with two decimals, derived from the last `PING`/`PONG` round trip; before the first measurement it SHALL read `lag –`.
4. THE agent panel SHALL read `<a> agents · <w> away · <o> ops` for the Active_Window when it is a Channel_Window: `a` = members that are Known_Agents, `w` = members known to be away, `o` = members with `@`. In other windows it SHALL show the totals over all open channels with duplicate nicks counted once.
5. THE Store SHALL send `PING :seance-lag-<n>` every 30 s while `registered`, using the injected timer, SHALL match the `PONG` token and compute the lag from the injected clock, SHALL ignore unmatched `PONG`s, and SHALL stop the timer on close, dispose and reconnect.
6. THE panels SHALL use Win95_Sans 12, black on the chrome face, and SHALL not wrap.
7. THE Status_Bar SHALL keep `role="status"` semantics without announcing every lag update (`aria-live="off"` for the lag panel).

### Requirement 7: Topic bar

**User Story:** As an operator, I want the topic bar to show channel, modes and topic like the mockup.

#### Acceptance Criteria

1. THE Topic_Bar of a Channel_Window SHALL read `<channel> (<modes>): <topic>` on the ghost background, 24 px high, IBM Plex Mono 14, with the channel name in the accent orange, the modes in the dim token and the topic in the text token.
2. THE modes and the topic SHALL be omitted under the rules of Requirement 1 criterion 4; the topic SHALL pass through `IrcText`.
3. WHEN the topic is long, THE Topic_Bar SHALL truncate with an ellipsis and expose the full text through `title`.

### Requirement 8: Channel and user modes in the client state

**User Story:** As a developer, I want the client to track the modes it displays, so that the title, topic bar and status bar are correct.

#### Acceptance Criteria

1. THE Reducer SHALL store `modes` (a string such as `+mnt`, flags only, sorted, without arguments) per Channel_Window and `userModes` per connection.
2. WHEN the client joins a channel THE Store SHALL send `MODE <channel>` once; THE Reducer SHALL set `modes` from `324 RPL_CHANNELMODEIS`.
3. WHEN a channel `MODE` changes flags without a member argument (`+m`, `-m`, `+i`, `+n`, `+t`, …), THE Reducer SHALL update `modes` and still log the Event_Line; flags that take a parameter or a member (`o`, `v`, `b`, `k`, `l`, `e`, `I`) SHALL not enter `modes`.
4. THE Reducer SHALL set `userModes` from `221 RPL_UMODEIS` and from `MODE <ownnick> <modes>`; WHEN the server reports nothing THE value SHALL stay empty.
5. THE reducer SHALL be total and pure, SHALL use null-prototype records and `Object.hasOwn` for keyed state as in `web-client-basic`, and SHALL ignore an unknown or malformed mode string without throwing.
6. THE state SHALL be reset (modes cleared) on reconnect like members and topics.

### Requirement 9: Away tracking

**User Story:** As an operator, I want to see which agents are away, so that the nick list and the status bar show who is busy.

#### Acceptance Criteria

1. THE Reducer SHALL mark a nick as away when it sees `301` for that nick (from WHOIS or from a PRIVMSG reply), when it sees an inbound `AWAY :<text>` message with a prefix, and for the own nick on `306`; it SHALL clear the mark on an inbound `AWAY` without text and on `305` for the own nick.
2. WHEN an inbound `AWAY` message arrives from a member of an open channel, THE Reducer SHALL write `* <nick> is away (<text>)` as an action-style line, and on clearing `* <nick> is back`, to every open channel that holds the member.
3. THE away mark SHALL be stored per nick (`irc_lower`) in a bounded null-prototype record (at most 200 entries, oldest dropped), SHALL be cleared on reconnect, and SHALL move with a `NICK` change and be dropped on `QUIT`.
4. THE away text SHALL be untrusted and rendered only through `IrcText`.
5. THE client SHALL not poll WHOIS to learn away states.

### Requirement 10: Chat line format

**User Story:** As an operator, I want chat and event lines in the exact classic format.

#### Acceptance Criteria

1. THE timestamp SHALL be `[HH:MM]` in the dim token, followed by one space.
2. THE chat line of a message SHALL read `<@nick> text` for an op, `<+nick> text` for a voiced member and `<nick> text` otherwise, using the member state of the channel at render time, with the mode prefix inside the angle brackets and coloured with the nick colour.
3. THE Event_Lines SHALL start with `*** `: `*** nick (user@host) has joined #chan`, `*** nick (user@host) has left #chan (reason)`, `*** nick (user@host) has quit (reason)`, `*** nick is now known as new`, `*** nick sets mode: +o target`, `*** nick sets topic: text`, `*** nick invited target`, `*** Now talking in #chan` for the own join; the `(user@host)` part SHALL be taken from the message prefix and omitted when the prefix has no `!` and `@`.
4. THE own join SHALL also add `--- Session start: <local date time>` once per connection to the Status_Window and each new Channel_Window.
5. JOIN lines SHALL use the `event` green, action (`* …`) lines the `action` purple, notice lines `-nick- text` the accent orange, tool lines (`-tool- …`) the tool-notice grey, and numerics `NNN text` with the MOTD heading bold, per the style guide.
6. Mention lines SHALL keep the 3 px accent bar and the warm row background of the mockup, with the own nick bold in the accent orange.
7. THE Chat_Buffer SHALL be bottom-anchored (short content sits at the bottom), IBM Plex Mono 15 px / 21 px rows, with no font smaller than 11 px and text contrast of at least 4.5:1 on the ghost background.
8. THE `user@host` text, nick, reason and topic SHALL be untrusted and SHALL pass through `IrcText`.

### Requirement 11: Kick moment and exorcism line

**User Story:** As an operator, I want the kick of an agent to read exactly like the mockup.

#### Acceptance Criteria

1. THE Exorcism_Line for a `KICK` of a Known_Agent SHALL read `*** <agent> has been exorcised by <kicker> (<reason>)` and SHALL carry no `[exorcised]` label or any other marker before the text.
2. WHEN the reason is empty, contains no visible text, or equals the kicker nick (compared with rfc1459 case-mapping), THE line SHALL be `*** <agent> has been exorcised by <kicker>` with no parentheses.
3. THE line SHALL show the agent nick struck through and dimmed in the nick colour, the word `exorcised` bold in the accent orange, a ghost glyph at its end, a 3 px left bar in the purple token and a faint row background, as in frame `03 Kick`.
4. THE strike-through and dimming SHALL be conveyed in text too (the glyph has `role="img"` with the name `exorcised`), so the meaning does not rely on colour.
5. A `KICK` of a nick that is not a Known_Agent SHALL keep the plain kick line `*** <nick> was kicked from <chan> by <kicker> (<reason>)` with the same empty-reason rule.
6. THE Nick_List SHALL keep a struck-through, dimmed row for the exorcised agent below the live members until the same nick joins again, the window closes or the client reconnects; this row SHALL not count as a user or an agent.
7. THE exorcism state SHALL be a UI field of the window (`exorcised` nicks), SHALL be bounded to 20 entries, and SHALL not alter the member set of the Reducer.
8. THE animation of floating ghosts of the mockup SHALL not be implemented; no motion SHALL be added, so `prefers-reduced-motion` needs no special case.

### Requirement 12: Nick list

**User Story:** As an operator, I want the nick list to show who is an agent and what it is doing.

#### Acceptance Criteria

1. THE Nick_List SHALL be 181 px wide with the ghost background, entries 20 px high on a 22 px pitch, IBM Plex Mono 15, sorted ops, voiced, then others as today.
2. EACH Known_Agent entry SHALL show a 12 px ghost status icon at the right edge of the row: blue for `coder`, green for `reviewer`, purple for `researcher` while active, grey while the agent is away; the icon SHALL have an accessible name `agent` or `agent, away`.
3. A member that is away SHALL be shown with the dim grey text token; humans keep the accent orange.
4. THE footer SHALL read `<u> users · <a> agents` in IBM Plex Mono 12 in the dim token at the bottom of the list, where `u` is the member count including agents and `a` the Known_Agent count; exorcised rows are excluded.
5. THE list SHALL keep `role="list"` with the label `Members of <channel> (<u> users)` and nick text SHALL pass through `IrcText`.

### Requirement 13: WHOIS answer lines

**User Story:** As an operator, I want a WHOIS answer to look like classic client output.

#### Acceptance Criteria

1. THE grouped WHOIS answer SHALL render as consecutive lines, each starting with the timestamp and the nick in bold in its nick colour, followed by the text: `<nick> is <user>@<host> * <realname>`, `<nick> on <channels>`, `<nick> <320 line>` for every `320` line in order, `<nick> has been idle <n>secs, signed on <date>` and `<nick> End of /WHOIS list.`, between two empty `-` separator lines.
2. THE WHOIS server line and away line SHALL follow the same pattern (`<nick> using <server> <info>`, `<nick> is away: <text>`) when present.
3. THE `320` lines SHALL be shown as received (model, tools, status, credits); the client SHALL not reformat them, except that the Credits_Counter (Requirement 5) reads the credits line.
4. THE text SHALL pass through `IrcText`; a WHOIS answer SHALL still be collected per nick as in `web-client-basic` and SHALL appear in the Active_Window.
5. THE old boxed `WhoisBlock` SHALL be removed; the `LineKind` `whois` MAY be kept for the data, but its rendering SHALL be line-based.

### Requirement 14: Status window line formats

**User Story:** As an operator, I want the connection and MOTD output to look like the mockup.

#### Acceptance Criteria

1. NUMERIC lines SHALL render as `[HH:MM] NNN text` with the numeric code in the dim token; MOTD heading lines (`375`) SHALL be bold; MOTD body lines (`372`) SHALL keep the leading `- `; the `376` line SHALL read the server text.
2. Server notices SHALL render as `-<server>- text` in the accent orange; connection progress lines (`* Connecting to <host> (<port>)`, `*** Connected to <host> (TLS)`) SHALL be written by the Store using the action purple and event green tokens.
3. THE MOTD lines SHALL be rendered in a monospace pre-formatted way (spaces preserved, no wrapping inside a line) so that ASCII art from the server keeps its shape; colours come from IRC colour codes sent by the server only.
4. THE Status_Window SHALL be a MDI_Child with the title `Status: <nick> on <host>`.

### Requirement 15: Win95 scrollbars

**User Story:** As an operator, I want scrollbars in the Win95 style.

#### Acceptance Criteria

1. THE Chat_Buffer and the Nick_List SHALL show 16 px wide vertical scrollbars with up and down arrow buttons, a dithered track and a raised thumb, using only theme tokens and `::-webkit-scrollbar` plus `scrollbar-color`/`scrollbar-width` fallbacks.
2. THE styles SHALL be defined once in `globals.css` and SHALL need no inline `style` or script.
3. THE buffer SHALL keep keyboard scrolling (`PageUp`, `PageDown`, arrow keys when focused) and `role="log"` with `aria-live="polite"`.

### Requirement 16: Typography and tokens

**User Story:** As a developer, I want the style guide tokens defined once.

#### Acceptance Criteria

1. THE window titles, menus, buttons, dialogs, switchbar and status bar SHALL use the Win95_Sans token (`font-chrome`, Arimo); chat, nick list, topic bar, input and the credits counter SHALL use IBM Plex Mono; VT323 SHALL stay for display titles only.
2. NEW colours (title-inactive gradient, timestamp dim, link blue, action purple, event green, tool grey, away grey, mention bar) SHALL be added once to `@theme` in `globals.css` with values read from `00 Style guide`; components SHALL use utilities only and no hex value.
3. EACH new text and background pair SHALL meet 4.5:1 (3:1 for large text); the contrast test of `web-client-basic` SHALL be extended with the new pairs.
4. Chat text SHALL be at least 14 px and no text SHALL be smaller than 11 px.

### Requirement 17: Security and compatibility

**User Story:** As a maintainer, I want the polish not to weaken any security rule.

#### Acceptance Criteria

1. THE change SHALL add no inline `style` attribute, no `dangerouslySetInnerHTML`, no `eval`, no external request (fonts, icons, images) and no change to the CSP beyond what a new asset path requires; the e2e CSP test SHALL still pass.
2. EVERY server-supplied string (topic, nick, user, host, reason, away text, WHOIS fields, `320` lines, MOTD) SHALL be rendered as React text through `IrcText`.
3. THE word "mIRC" SHALL appear in none of the new code, text, alt text or assets.
4. THE new Store timers (lag) SHALL use the injected `setTimeout`/`clearTimeout` and SHALL stop in `dispose()`.
5. THE client SHALL send only the new commands `MODE <channel>` and `PING :seance-lag-<n>`; both SHALL stay within the 512-byte limit and pass `serialize`.
6. THE existing tests of `web-client-basic` SHALL keep passing, except where a requirement of this spec intentionally changes the behaviour (kick line marker, WHOIS block, menu items); those tests SHALL be changed in the same task, never deleted.

### Requirement 18: Verification against the mockup

**User Story:** As a maintainer, I want evidence that the client matches the frames.

#### Acceptance Criteria

1. THE e2e test SHALL cover: title text for status and channel, the seven menu names, a disabled menu item, minimise and restore of a window, the status bar text after registration, the Credits_Counter after a WHOIS of a fake agent, the exorcism line text for a kick with and without a reason, and the new security headers.
2. A Playwright MCP visual check SHALL open the production build with the Fake_Agent stack, take screenshots at 1440×900 of the states in frames `01 Main`, `02 Status/MOTD`, `03 Kick` and `04 Whois` (without the dialog), and compare them to the exported frames; the differences SHALL be recorded in the task notes.
3. THE visual check SHALL be a manual task; it SHALL not be part of `pnpm test`.
4. THE usage log SHALL record the Figma sources used.
