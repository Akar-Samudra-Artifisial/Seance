# Requirements Document: web-client-extras

## Introduction

The web client still shows toolbar and menu controls that do nothing and say nothing: Channel list, Toggle theme, Help → Keyboard shortcuts, and several more. This spec gives them behaviour, or an explanation. It also fixes the runner WHOIS `tools:` line, which names a sandbox that is not in use.

Goal: **no visible toolbar or menu control in `apps/web` is dead without explanation.** Options (toolbar button and Tools menu) and the Favorites menu had no feature behind them; they were first explained ("Coming soon") and, in the follow-up of 2026-11-10 (task 9), removed from the chrome. They stay a future idea in `DESIGN.md` and the README.

Figma sources (Talk-to-Figma channel `8p9g0i9k`, or the Figma power file `GFgFsC9HEkntrirqCmJP5I`):

- `05 Channel list` (node 1:3814): the channel list dialog.
- `06 Classic` (node 1:1623): the Classic theme. Colours are read from the frame.
- `04 Whois+Options` (node 1:2947): dialog chrome for dialogs without their own frame.

## Glossary

- **Channel_List_Dialog**: modal dialog of frame 05, filled from `LIST`.
- **List_Row**: one validated `322` reply: channel, users, topic, plus a derived agent count.
- **Agent_Count**: number of members of a channel for which `isKnownAgent(nick)` holds; `null` while unknown.
- **Theme**: `ghost` (default) or `classic`.
- **Shortcut_Registry**: the single module that defines every keyboard shortcut the client implements.
- **Explained_Disabled**: a control that is inert and carries a non-empty `title` and `aria-description` saying why.

## Requirements

### Requirement 1: Channel list

**User Story:** As an operator, I want to see which channels exist and join one, so that I do not have to type `/list` and read the Status window.

#### Acceptance Criteria

1. THE toolbar button "Channel list" and a menu entry (Commands → Channel list…) SHALL be enabled while registered, and SHALL send `LIST` and open the Channel_List_Dialog.
2. WHILE the reply is incomplete THE dialog SHALL show "Loading…"; the `323` reply SHALL end loading. An empty list SHALL show "No channels".
3. THE reducer SHALL collect `321` (optional), `322` and `323` into list state only while a list request is loading; otherwise `322`/`323` SHALL keep going to the Status window as before.
4. THE reducer SHALL drop a `322` whose channel name is empty, longer than 200 characters or contains a space, or whose user count is not 1 to 9 digits. It SHALL keep at most 500 rows and set `truncated` when more arrive. Topics SHALL be shown through `plain()`/`IrcText`, never as markup.
5. IF `323` does not arrive within 15 seconds, THEN the dialog SHALL show an error and the Refresh button SHALL retry.
6. THE dialog SHALL filter by text (channel name or topic, case-insensitive, control codes ignored), by minimum agents, and by "Hide channels without a topic". Filters SHALL apply on "Apply filter" or Enter in a field.
7. THE column headers (Channel, Agents, Users, Topic) SHALL be buttons that sort ascending, then descending, then back to server order. Sorting SHALL be reachable by keyboard and announce `aria-sort`.
8. Double-click or Enter on a row, and the Join button, SHALL submit `/join <channel>` and close the dialog.
9. Esc and Close SHALL close the dialog and return focus to the control that opened it. The "?" button SHALL toggle a one-line keyboard hint.
10. THE list state SHALL be cleared on reconnect.

### Requirement 2: Agents column

**User Story:** As an operator, I want to see how many agents work in each channel.

#### Acceptance Criteria

1. THE `322` numeric format SHALL NOT change.
2. THE client SHALL derive Agent_Count by counting members that are Known_Agents (the same definition as the nick list and the window title). For a joined channel it SHALL use the window's members; for others it SHALL send `NAMES` in batches that keep each line within 512 bytes and count the `353` replies, finishing a channel at its `366`.
3. UNTIL a count is known THE column SHALL show "—". THE "Min agents" filter SHALL ignore rows whose count is unknown.
4. THE client SHALL ignore `353`/`366` replies for channels it did not ask about, and SHALL NOT show them in the Status window.

### Requirement 3: Theme toggle

**User Story:** As a user, I want a light "Classic" look next to the dark "Ghost" look.

#### Acceptance Criteria

1. THE toolbar button "Toggle theme" and View → Ghost theme / Classic theme SHALL switch the theme. The toolbar label SHALL read "Theme: Ghost" or "Theme: Classic".
2. THE Classic theme SHALL be a token set: CSS custom properties under `html[data-theme="classic"]` in `app/globals.css`. There SHALL be no inline style, no `dangerouslySetInnerHTML`, no change to the CSP or `proxy.ts`.
3. THE chosen theme name SHALL be stored in `localStorage` under `seance.theme`. A stored value other than `ghost` or `classic` SHALL be ignored.
4. EVERY text and background pair used in both themes SHALL reach 4.5:1 (3:1 for non-text). THE contrast test SHALL list the Classic pairs. Colours from frame 06 that fail SHALL be lifted and recorded in design.md.
5. A Playwright baseline for Classic at 1440x900 SHALL exist, and a comparison against the frame 06 export SHALL run the same way as for frame 01 once that export is saved.

### Requirement 4: Keyboard shortcuts

**User Story:** As a user, I want a list of the keys the client understands.

#### Acceptance Criteria

1. Help → Keyboard shortcuts SHALL open a dialog in the style of frame 04 that lists every shortcut.
2. THE list SHALL be generated from the Shortcut_Registry. The same registry SHALL drive the real handlers (window switch by Alt+digit, menu mnemonics, history, completion, Esc). A test SHALL fail when a handler and the registry disagree.
3. THE dialog SHALL state the paste limits, built from `PASTE_MAX_LINES` and `PASTE_INTERVAL_MS`.

### Requirement 5: Explained disabled controls

#### Acceptance Criteria

1. EVERY visible toolbar, menu, menu-bar caption and title-bar control that is disabled or inert SHALL be an Explained_Disabled control, in every state of the client.
2. THE reasons SHALL be specific ("Disconnect first", "Already the last window", "Connect first", "Join a channel first").
3. A generic test SHALL render the controls in several states and fail on any disabled control without a reason.
4. (Superseded 2026-11-10.) THE toolbar Options button, Tools › Options… and the Favorites menu SHALL NOT exist, because a control that never works looks unfinished: the toolbar is connect | channel list, agents | status window | theme, the menu bar is File, View, Tools, Commands, Window, Help (every remaining menu keeps its `Alt+<letter>` key and the arrow keys wrap over the six). Controls that are disabled only in some states keep their reasons.
5. THE title-bar Maximise button SHALL toggle browser full screen through the Fullscreen API on `document.documentElement` where `document.fullscreenEnabled` is true: `aria-label` and `title` are `Full screen` and, while in full screen, `Exit full screen`, following `fullscreenchange` (also after Esc). A rejected request is ignored silently. Where full screen is not available the button stays inert with "Not available in a browser tab". Minimise stays inert with that reason.

### Requirement 6: Runner WHOIS tools label

#### Acceptance Criteria

1. WHEN `SEANCE_SANDBOX=none`, THE `320` "tools:" line SHALL show `shell(host)`. WHEN `podman`, it SHALL show `shell(sandbox)`.
2. THE label SHALL come from the runner's configured sandbox mode, not from the agent profile text.

### Requirement 7: Quality

#### Acceptance Criteria

1. THE changes SHALL leave the existing tests intact; a test changes only for intended behaviour, with a comment.
2. THE word that names the trademarked client SHALL appear nowhere in the repository files this spec touches.
3. THE Figma calls made for this spec SHALL be recorded in `docs/KIRO_USAGE.md`.

### Requirement 8: Audit fixes (2026-11-10)

#### Acceptance Criteria

1. `/notice <target> <text>` and `/privmsg <target> <text>` SHALL send the whole text as one trailing parameter and echo it like `/msg`; CR, LF and NUL SHALL still be rejected.
2. `/help` SHALL print one usage line per command of the command table into the active window, and `/clear` SHALL empty it; neither SHALL send anything.
3. A Reconnect SHALL rejoin every open channel window and use the last nick the server confirmed; the Connect_Dialog after a Quit SHALL prefill that nick.
4. WHEN the active window closes, THE client SHALL activate the next window that is not minimised, or restore and activate the Status_Window when none is left.
5. In the nick list, double-click and Enter SHALL open a query; a context menu (right-click, Shift+F10, Menu key) SHALL offer Whois, Query, Give/Take voice and Kick, the last two inert with a reason unless the user is a channel operator; focus SHALL return to the nick on close.
6. Agent replies SHALL show no stray colour digits: the runner SHALL remove an agent's own colour code as a whole sequence before adding its colour.
7. In Compact, the `»` list SHALL list every menu that does not fit and each entry SHALL open its own menu.
8. `/list` without arguments SHALL open the Channel_List_Dialog; `/mode #chan` without a mode string SHALL print the channel modes into that channel's window.
9. Menu items that only prefill the Input_Line SHALL carry no ellipsis.
10. THE app SHALL serve a favicon (`app/icon.svg`); on Desktop and Medium the toolbar Agents button SHALL focus the nick list and print `N agents in #chan` or `No agents in #chan`.
11. `/ban` and `/unban` SHALL send `MODE <channel> +b|-b <mask>`; the ircd SHALL implement them (ircd-core criteria 9.11 to 9.15) and the runner SHALL mirror bans of agent nicks into its ban list.
12. THE docs and in-app shortcut texts SHALL describe the above.
13. THE ircd SHALL match ban masks without a regular expression and collapse runs of `*` (ircd-core criterion 9.16); MODE `+b` SHALL answer an invalid mask with a NOTICE naming it and a full list with `478` (ircd-core criteria 9.17, 9.18).
14. Tab in the Input_Line SHALL complete only when a nick matches or a completion is active, and move focus otherwise; Shift+Tab SHALL move focus back unless it steps through an active completion.
15. EVERY focusable element SHALL show a focus ring whose colour differs from, and has at least 3:1 contrast against, what is behind it, in Ghost and Classic.
16. THE nick menu SHALL open at the pointer or under the row, stay inside the viewport, close with focus returned to the list when its nick leaves, and use ids that are unique per instance.
17. THE status bar SHALL pluralise its counts and give each text panel a `title`; a message to the own nick SHALL be shown in the Active_Window and not open a query; the Compact `»` list SHALL close on an outside press and Esc and stay inside the viewport.
