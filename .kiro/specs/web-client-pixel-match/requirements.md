# Requirements Document

## Introduction

`web-client-pixel-match` brings `apps/web` at 1440x900 pixel-close to Figma frame `01 Main` (1:1093) and makes it usable from 360 px up. It builds on `web-client-basic` and `web-client-polish`. It adds nine fixes found by comparing the running client (`/tmp/seance-pixel/app-01-main-1440.png`) with the frame export, the exact Figma icons, a responsive layout that Figma does not cover, and screenshot tests that prove both.

Figma file: `GFgFsC9HEkntrirqCmJP5I` (Séance). Layout values come from one Figma-power `get_design_context` call for 1:1093. Everything else was read with Talk-to-Figma (channel `8p9g0i9k`): 00 Style guide (1:4830), 01 Main (1:1093), 04 Whois (1:2947), and the exported icon SVGs. They are now committed in `apps/web/design/figma-icons/` (23 files), because `/tmp` is not durable.

### Findings that shape the requirements

1. **The `[hh:mm] -` lines are the WHOIS separators, and they are intended.** In the screenshot they sit right before and right after the WHOIS block. They come from `WhoisLines.tsx` (`sep-top`, `sep-bottom`). They are not empty chat lines and not agent output. Frame 04 draws exactly these two rows (`[23:48] -`, nodes 1:3541 and 1:3550). Frame 01 has no WHOIS. The product owner decided on 2026-11-08 that they stay exactly as Frame 04 draws them (Requirement 9); the earlier request to remove them was withdrawn.
2. **Today's channels already behave as `+nt`.** `canSpeak` rejects every non-member (so "no external messages" is always on) and `TOPIC` is op-only (so "topic lock" is always on), but `MODE +n` and `+t` answer `472`. Requirement 12 turns these two behaviours into real flags that default to on.
3. **The e2e stack builds the production bundle** (`next build`, `NODE_ENV=production`) into the same `.next` directory a deployment would use. A fixture gated by `NODE_ENV=test` would not exist in that bundle. Requirement 14 uses a build-time switch and a separate output directory instead.
4. **The repo lifts three Figma text colours for contrast** (`timestamp-dim` `#8a8578` for Figma `#7a756b`, `away-grey` `#7e7e87` for `#5f5f66`, and the inactive caption). Pixel comparison against Figma will show small colour differences in those texts. They stay, because `.kiro/steering/web-ui.md` requires 4.5:1 and the Figma values fail it.
5. **Figma's human nick colour is `#e08a2e`** (frame 01, 00 Style guide "human · orange"), while the steering rule and `--color-nick-human` said `#c8761f`. The product owner decided on 2026-11-08 to adopt the Figma value: `--color-nick-human` and `.kiro/steering/web-ui.md` change to `#e08a2e` (Requirement 6.5). Its contrast on `#0b0b0f` is 7.34:1, above the 4.5:1 floor. The accent orange `#c8761f` (mentions, notices, `-ChanServ-`) is a different token and does not change.
6. **The Figma icon files are composites for a few controls.** `scrollbar-vertical.svg` and `scrollbar-horizontal.svg` are fixed-length drawings (arrows plus a thumb); `credits-candle.svg` contains baked `<text>` and an inline `style`; `caption-buttons.svg` repeats the three button files. The app needs slices of them (Requirement 3).
7. **The frame has 2 px gaps between regions and a 3 px outer bevel**, which the current layout does not reproduce (Requirement 1).

## Glossary

- **Client:** the web app in `apps/web`.
- **Frame_01:** Figma frame `01 Main`, 1440x900.
- **Figma_Export:** a PNG export of Frame_01 at scale 1, committed as `apps/web/e2e/figma/01-main-1440x900.png`.
- **Region:** one horizontal band of the window: title bar, menu bar, toolbar, topic field, chat pane with nick list, input line, minimised tray, switchbar, status bar.
- **Desktop / Medium / Compact:** viewport width at least 1024 px / 768 to 1023 px / below 768 px.
- **Maximised_Child:** the one MDI child shown in the MDI area. The Client always shows exactly one.
- **Icon_Set:** the 23 SVGs in `apps/web/design/figma-icons/` plus the extra icons of Requirement 3.
- **Event_Token:** `--color-event-green` (`#6a9955`).
- **Fixture:** the test-only page that renders the Frame_01 content without a server.
- **Contrast_Floor:** 4.5:1 for text, 3:1 for large text and UI parts, per `web-ui.md`.
- **Coarse_Pointer:** a device matching `@media (pointer: coarse)`.

## Non-goals

- The Classic theme, the theme toggle behaviour, the floating-ghost animation, scanlines.
- The `Agent Options` dialog and the `Connect` dialog layouts (frames 02 and 04 dialog parts).
- The `-tool-` line wording of Frame_01 and the `-ChanServ- coder touched ...` line (not produced by any server today).
- Making the maximised child restorable into a floating window. The Client keeps one maximised window.
- Pixel parity of font anti-aliasing between Figma's renderer and Chromium.

---

## Requirements

### Requirement 1: Frame and region metrics at 1440x900

**User Story:** As a designer, I want the window to have the Frame_01 proportions, so that the screenshot lines up with the mockup.

#### Acceptance Criteria

1. AT 1440x900 THE Client SHALL draw a 3 px raised outer bevel (highlight `#ffffff` and `#dfdfdf` top and left, `#808080` and `#000000` bottom and right) on `#c0c0c0`, and place the regions inside the 1434x894 area at these heights, with the gaps between them:

   | Region | y | height | gap after |
   |---|---|---|---|
   | Title bar | 3 | 22 | 0 |
   | Menu bar | 25 | 20 | 0 |
   | Toolbar | 45 | 32 | 2 |
   | Topic field | 79 | 24 | 2 |
   | Chat pane and nick list | 105 | 686 | 2 |
   | Input line | 793 | 24 | 2 |
   | Minimised tray (only while a window is minimised) | 819 | 28 | 2 |
   | Switchbar | 849 | 26 | 1 |
   | Status bar | 876 | 21 | 0 |

2. THE chat pane SHALL be 1250 px wide including a 16 px scrollbar, and the nick list SHALL be 181 px wide and start 3 px after the chat pane, both 686 px high.
3. THE Client SHALL use IBM Plex Mono 15 px with a 21 px line pitch for chat, nick list and input, Arimo 12 px for chrome, and Arimo 12 px bold for titles.
4. WHEN no window is minimised THE tray row and its gap SHALL be absent and the chat pane SHALL grow by 30 px.
5. THE Client SHALL give the topic field and the input line the sunken two-step bevel (`#808080`/`#ffffff` outside, `#000000`/`#dfdfdf` inside) and the Frame_01 text positions: text starts 8 px from the field's left edge.
6. THE status bar SHALL have four sunken panels with these widths at 1434 px: connection 562 px, lag 140 px, agents 258 px, filler the rest, separated by 3 px.
7. THE minimised tray bar SHALL be 176x24 px at 6 px from the left and 2 px from the top of the tray row; switchbar buttons SHALL be 156x22 px on a 160 px pitch starting 2 px from the left; the credits panel SHALL be 160x22 px at the right edge.
8. ALL heights SHALL be set by classes (no inline `style`), and the sizes SHALL live in one layout token block in `app/globals.css`.

### Requirement 2: Maximised child merged into the frame

**User Story:** As a user of a classic client, I want the active window to merge into the application frame, so that there is one title bar and one menu bar.

#### Acceptance Criteria

1. THE Client SHALL NOT render a title bar inside the Maximised_Child. The `MdiChild` header, its caption buttons and its 3 px padded bevel SHALL be removed.
2. THE menu bar SHALL show the Maximised_Child icon at its left, 5 px from the edge (14x14: `#` for a channel, the monitor for Status, the ghost for a query), and the child's minimise, restore and close buttons at its right, each 16x14 with a 2 px gap, ending 2 px from the right edge.
3. THE child buttons SHALL keep their current actions: minimise sends the window to the tray; close closes it (disabled for Status); restore SHALL be `aria-disabled` with the title "Restore (this client keeps one maximised window)" when the window is not minimised.
4. THE title bar text SHALL read `Séance — [<window> (<modes>): <topic>]` for a channel (modes and topic omitted when empty, topic cut at 120 characters), `Séance — [Status: <nick> (<usermodes>) on <host>]` for Status and `Séance — [<nick>]` for a query. The existing `titleOf` selector stays the single source.
5. THE topic field (Requirement 1) SHALL move out of the child to the application level for channel windows, and SHALL be absent for Status and query windows (their row is removed and the chat pane grows).
6. THE topic field text SHALL show the channel name in the accent orange, the modes `(+mnt)` in the dim token and the topic in the text token, as Frame_01 node 1:1337 does.
7. THE existing ARIA structure SHALL remain: the window is a `section` labelled `<name> window`; the chat is a `role="log"`; the menu bar is a `menubar`.

### Requirement 3: Exact icons

**User Story:** As a designer, I want the icons to be the Figma drawings, not look-alikes.

#### Acceptance Criteria

1. THE Client SHALL render every icon of the Icon_Set from React components in `apps/web/src/icons/` (outside `src/components/`, whose static test forbids hex colours), one component per file, generated from the committed SVGs without changing a path, a coordinate or a colour.
2. EACH component SHALL: use the file's `viewBox` and drop `width` and `height` (the size comes from a class); add `shape-rendering="crispEdges"`; add `aria-hidden="true"` and `focusable="false"`; contain no `style` attribute, no `<text>` and no `xmlns` duplicates in React output.
3. A component SHALL use `currentColor` only where the source has exactly one fill colour and that colour is the foreground (`mdi-child-channel` `#000080`, `switch-channel` black). Multi-colour icons keep their own colours.
4. THE composite files SHALL be sliced as follows, each slice with unchanged path data:
   - `credits-candle`: the candle circle (the `<path>` with fill `#C8761F`) only; the frame and the text are drawn by HTML and CSS (Requirement 8).
   - `scrollbar-vertical` and `scrollbar-horizontal`: four 16x16 arrow buttons (up, down, left, right) and one 16 px thumb strip; the tracks are CSS.
   - `caption-buttons`: not used; the three single button files are used.
5. IN ADDITION, THE Client SHALL add these icons, drawn at 16 px in the same pixel style and palette as the set, because the UI needs them and the set does not contain them: `nick-agent-researcher` (the ghost of `nick-agent-coder` with fill `#9A7FD1`), `btn-min-pressed`, `btn-max-pressed`, `btn-restore-pressed`, `btn-close-pressed` (the button files with the sunken bevel: shadow top and left, highlight bottom and right, glyph moved 1 px down and right), `scroll-arrow-up-pressed`, `scroll-arrow-down-pressed`, `scroll-arrow-left-pressed`, `scroll-arrow-right-pressed`, `overflow-chevrons` (the `»` menu button of Compact), and `mdi-child-query` (the `switch-query` ghost at 14 px for the menu bar). Every added icon SHALL be listed in `design.md`.
6. THE existing `Icon` component SHALL be removed once nothing imports it; the name map for the ghost icons SHALL point to the new components.
7. THE away ghost for an agent SHALL be `nick-agent-researcher-away`, whatever the agent.
8. A test SHALL check, for every source SVG, that the component's rendered path data and fills equal the file's, and that no output contains `style`, `width=`, `height=` or `<text`.

### Requirement 4: Toolbar order and geometry

**User Story:** As a user, I want the toolbar to be the same as the mockup.

#### Acceptance Criteria

1. *(`options` removed by web-client-extras task 9, 2026-11-10; the toolbar is now `connect` `|` `channel list` `agents` `|` `logs` `|` `theme toggle`.)* THE toolbar SHALL contain, in this order, with 2x22 sunken separators where `|` stands: `connect` `|` `options` `|` `channel list` `agents` `|` `logs` `|` `theme toggle`. `channel list` and `agents` SHALL sit 1 px apart, with no separator between them.
2. EACH button SHALL be 26x24, 4 px from the toolbar's top. The first button SHALL start 4 px from the left. A separator SHALL start 4 px after the button before it, and the next button SHALL start 3 px after the separator. The separator SHALL be 1 px lower than the buttons and 22 px high.
3. THE glyph SHALL be centred in the button (Frame_01 offsets: connect glyph at 8,5; options at 5,4; channel list at 7.5,5.5; agents at 7.4,5.4; logs at 7.5,5.5; theme at 7,6).
4. THE label `Theme: Ghost` SHALL end 33 px from the right edge of the toolbar (Frame_01 measurement) (Desktop and Medium); it SHALL be hidden in Compact.
5. THE order of the existing actions SHALL stay: connect/reconnect, options (disabled), channels (disabled), agents (focus the nick list; in Compact it toggles the overlay of Requirement 11), logs (Status), theme (disabled).
6. THE buttons SHALL keep `role="toolbar"` roving focus, `aria-label` and `title`, and the `aria-disabled` pattern.

### Requirement 5: Menus and Favorites

> **Superseded 2026-11-10 by web-client-extras task 9.** The Favorites menu (criterion 1) and the Options toolbar button (Requirement 4, criteria 1 and 5) had nothing behind them and were removed. There are six menus, with slot widths 42, 42, 49, 69, 56, 56 (criterion 2 below lists the original seven); criterion 3 still holds. The text below is kept as history.

**User Story:** As a user, I want Favorites to open like the other menus.

#### Acceptance Criteria

1. THE Favorites menu SHALL be enabled, SHALL open like the others, and SHALL contain one item "No favorites yet" with `aria-disabled="true"` that does nothing when activated.
2. THE seven menu buttons SHALL start at x = 31, 73, 115, 190, 239, 308, 364 (relative to the frame) and SHALL have widths 42, 42, 75, 49, 69, 56 and 56 px, left-aligned text, with the mnemonic underline kept as `<u>`.
3. THE menu keyboard behaviour and Alt shortcuts SHALL not change.

### Requirement 6: Event line colour

**User Story:** As a user, I want the `***` lines in the same green as the mockup.

#### Acceptance Criteria

1. EVERY line that renders with the `*** ` prefix and is one of `join`, `part`, `quit`, `nick`, `mode`, `topic` (including `No topic is set for ...`, `Topic for ...`, `... sets topic`, `... cleared the topic`) or `invite` SHALL use the Event_Token. `kick` and exorcism lines keep their own styles.
2. WHEN the Client receives `341 RPL_INVITING` for an invitation it sent, it SHALL append `*** <own nick> invited <target>` as kind `invite` to the channel window named by the reply (Status when that window is closed). WHEN it receives an `INVITE` addressed to itself, the existing line SHALL also use kind `invite` and the Event_Token.
3. THE word list of Requirement 6.1 SHALL be one constant used by `ChatLine` and by a test; there SHALL be no second list.
4. THE Event_Token SHALL meet the Contrast_Floor on `#0b0b0f` (a test already exists and stays).
5. THE human nick colour SHALL be `#e08a2e` (Frame_01 and 00 Style guide "human · orange"). `--color-nick-human` in `app/globals.css` and the human-nick rows of `.kiro/steering/web-ui.md` SHALL change to it; the accent orange `#c8761f` (mentions, notices, `-ChanServ-`, focus ring) SHALL NOT change. THE contrast test SHALL keep the pair `nick-human` on `ghost-bg` at 4.5:1 or more (the value is 7.34:1).

### Requirement 7: Chat pane and scrollbar

**User Story:** As a user, I want a Win95 chat pane with a scrollbar I can see.

#### Acceptance Criteria

1. THE chat pane SHALL have the sunken ghost bevel (Frame_01 vectors 1:1413 to 1:1420: 1 px `#808080`/`#ffffff` outside, 1 px `#000000`/`#dfdfdf` inside) on `#0b0b0f`.
2. THE chat pane SHALL always show a vertical scrollbar 16 px wide (`overflow-y: scroll`): the track `#dcdcdc`, two 16x16 arrow buttons built from the Requirement 3 slices, and a thumb with the Win95 bevel. WHEN the content does not overflow the thumb SHALL be absent and the arrow buttons SHALL remain.
3. THE arrow buttons SHALL show the pressed variants while active.
4. THE nick list SHALL have no scrollbar until its content overflows.
5. ON engines without `::-webkit-scrollbar` (Firefox) THE Client SHALL fall back to the current `scrollbar-color` rule. The pixel comparison applies to Chromium only.
6. THE chat pane SHALL keep `role="log"`, `aria-live="polite"`, keyboard scrolling and the bottom anchoring.

### Requirement 8: Switchbar and credits panel

**User Story:** As a user, I want the switchbar and the credits panel to be drawn like the mockup.

#### Acceptance Criteria

1. THE Status button SHALL show the Status icon (`switch-status`), a channel button the `#` icon (`switch-channel`), a query button the ghost (`switch-query`), 12 px, with 4 px between icon and text.
2. THE active button SHALL be bold and sunken; a button with unread lines SHALL use `#000080` text; a button with a mention SHALL use the accent orange. These existing rules stay.
3. THE credits panel SHALL be a 160x22 sunken panel with the candle slice at 7,6 (10x10), the text `credits: ` in IBM Plex Mono 13 from x 22, and the value in bold, in HTML, with the value formatted with one decimal as before. It SHALL carry `role="status"` semantics as today.

### Requirement 9: WHOIS separators stay; no empty chat lines

**User Story:** As a user, I want the WHOIS block as the mockup draws it, and I want chat lines to carry text.

#### Acceptance Criteria

1. THE Client SHALL keep the two separator rows of the WHOIS block exactly as Frame 04 draws them (nodes 1:3541 and 1:3550): a row `[hh:mm] -` directly before the first field row and a row `[hh:mm] -` directly after `End of /WHOIS list.`, with the timestamp in the dim token. `WhoisLines` SHALL NOT change for this requirement.
2. THE reducer SHALL NOT append a `message`, `action`, `notice`, `tool`, `tool-denied` or `local` line whose text has no visible character after IRC formatting and control stripping. MOTD (`motd`) blank rows, `numeric` rows and the WHOIS block are exempt, because blank MOTD rows are part of the server's art and the separators are intended.
3. A property test SHALL assert 9.2 for arbitrary text built from control codes and whitespace, and a unit test SHALL pin the two separator rows of 9.1 (first and last row of the block are `-` rows, nothing else renders as a bare `-` line).
4. `design.md` SHALL record the decision to keep the separators and that Frame_01 has no WHOIS.

### Requirement 10: Readable IRC colours

**User Story:** As a user, I want server and agent colours to stay readable on the dark chat surface.

#### Acceptance Criteria

1. FOR every IRC foreground colour index 0 to 15 used without a background, THE rendered colour on `#0b0b0f` SHALL have a contrast ratio of at least 4.5:1. Colours that fail today (at least 1, 2, 5, 6, 12 and any other the test finds) SHALL be rendered with a separate token `--color-irc-fg-N` holding the nearest lighter shade of the same hue, found by a script and committed as hex values, with a comment naming the original. `--color-irc-N` keeps the classic value for backgrounds and colour pairs (so a black background stays black).
2. FOR a colour code with a background, THE Client SHALL pick the foreground class from `text-irc-<fg>`, `text-irc-0` and `text-irc-1` so that the pair meets 4.5:1, using the original `fg` when it already does, otherwise the one of white and black with the higher ratio. The function SHALL be pure (`readableClass(fg, bg)`) and return a class name from a fixed list; no inline style.
3. THE colour used for the agent reply colour `\x0312` SHALL meet 4.5:1 after the change.
4. A test SHALL compute the ratio for all 16 foregrounds on the ghost background and for all 256 pairs through `readableClass`, and fail below 4.5.
5. THE substitution SHALL apply to every place `IrcText` renders, including titles and the nick list.

### Requirement 11: Responsive layout

**User Story:** As a phone user, I want the client to work on a narrow screen.

#### Acceptance Criteria

1. THE Client SHALL have no horizontal page overflow (`document.documentElement.scrollWidth <= clientWidth`, and no element's right edge beyond the viewport except inside an element that scrolls on purpose) at widths 360 and up, in portrait and landscape.
2. DESKTOP (at least 1024 px): the layout of Requirements 1 to 8 applies exactly. Below 1440 px the chat pane takes the remaining width and the nick list stays 181 px.
3. MEDIUM (768 to 1023 px): as Desktop with a 140 px nick list. Panel widths of the status bar scale (connection, lag, agents, filler in the Desktop ratio).
4. COMPACT (below 768 px):
   - The nick list is hidden. The toolbar `agents` button toggles an overlay panel (an `aside` with the nick list, `role="complementary"`, `aria-label` "Members of <channel>"), 240 px wide or 80 percent of the viewport if less, below the topic field, over the chat pane. Escape, a tap outside or the toolbar button closes it; opening moves focus to the list and closing returns it to the button.
   - The menu bar stays one row. As many menus as fit are shown; the rest move into a `»` menu button at the right of the menus (before the child buttons) that opens them as a submenu list. Menus keep their keyboard behaviour.
   - The toolbar stays one row and drops the theme label.
   - The status bar shows only the connection and agents panels; the connection text truncates with an ellipsis.
   - The switchbar scrolls horizontally inside its own row; the credits panel stays at the right and shows the candle and the value only (its label is hidden).
   - The topic field truncates with an ellipsis and exposes the full text in `title`.
5. THE input line SHALL stay visible above the on-screen keyboard: the Client SHALL observe `window.visualViewport` (resize and scroll), set the CSS variable `--app-height` to the visual viewport height on the document element through the CSSOM (`style.setProperty`), and size the shell with `height: var(--app-height, 100dvh)`. No `style` attribute is written by markup.
6. ON a Coarse_Pointer THE Client SHALL give every interactive control (buttons, menu buttons, switchbar buttons, input, links outside chat text) a hit area of at least 32x32 CSS px, by padding or a pseudo-element, without changing the drawn size at 1440x900 or on a fine pointer. The scrollbar arrow buttons are exempt.
7. THE Client SHALL set the viewport meta to `width=device-width, initial-scale=1` and SHALL NOT disable zoom.
8. TEXT SHALL stay at least 11 px at every width (existing rule).

### Requirement 12: Channel modes `n` and `t`

**User Story:** As an operator, I want `/mode #chan +mnt` to work.

#### Acceptance Criteria

1. THE Ircd channel state SHALL have the flags `moderated` (`m`), `noExternal` (`n`) and `topicLock` (`t`). A new channel SHALL start with `n` and `t` on and `m` off, which is the behaviour of today's server.
2. `MODE <channel> +n`, `-n`, `+t`, `-t` SHALL be accepted from channel operators, in any combination with `m`, `o` and `v`, and answered like `m`. A non-operator SHALL get `482`. An unknown flag SHALL still get `472`.
3. WHEN `n` is off a client that is not a member MAY send `PRIVMSG` and `NOTICE` to the channel, subject to `m`: with `m` on a non-member SHALL get `404`. WHEN `n` is on, a non-member SHALL get `404`, as today.
4. WHEN `t` is on only operators may change the topic and others get `482`, as today. WHEN `t` is off any member may set it. A non-member always gets `442`.
5. THE server SHALL broadcast one `MODE` message per accepted command, listing only the changes that changed state, grouped in sign runs (for example `+m`, `+mn`, `+o-v coder bob`), with arguments after the flags. A command that changes nothing SHALL broadcast nothing.
6. `MODE <channel>` (query) SHALL reply `324` with the flags sorted alphabetically after `+` (`+nt`, `+mnt`). `RPL_CREATIONTIME` is not added.
7. `004` SHALL advertise `mntov` as the channel modes, and `005` SHALL keep `PREFIX=(ov)@+`.
8. THE server SHALL publish `irc.mode` only for `o`, `v` and `m`, so the runner's port is unchanged.
9. THE web client SHALL show `(+mnt)` in the title and topic field with no change to its mode tracking, and its `MODE` line SHALL read `*** bayu sets mode: +mnt`.
10. `DESIGN.md` §3 SHALL list `+n` and `+t` and the defaults; the `ircd-core` tests that assert `324 +` for a fresh channel or one `MODE` message per flag SHALL be updated with the reason.

### Requirement 13: Verification fixture

**User Story:** As a maintainer, I want a stable page that renders the Frame_01 content.

#### Acceptance Criteria

1. THE Client SHALL provide a Fixture page at `/fixtures/01-main` that renders the real `Shell` with a store fed by an in-memory socket: no network, a fixed clock (2026-11-06 23:38 to 23:47 UTC), the Frame_01 channel, members, topic, modes `+mnt`, away state, credits `42.7`, the minimised Status window, unread `#landing-page` and the `coder` query.
2. THE chat lines SHALL be those of Frame_01 that the Client can produce (all of them except `-tool-` and `-ChanServ- coder touched ...`, which are fed as notices from `coder` and `ChanServ` so the screenshot has the rows).
3. THE script of IRC lines SHALL live in `apps/web/src/fixtures/figma-01-main.ts` and also be used by unit tests.
4. THE Fixture route SHALL exist only when the build runs with `SEANCE_E2E_FIXTURES=1`: `next.config.ts` adds the page extension `fixture.tsx` to `pageExtensions` only then, and the page file is `app/fixtures/01-main/page.fixture.tsx`. A normal `next build` SHALL contain no fixture route and no fixture code.
5. THE e2e harness SHALL build with that variable into its own output directory (`distDir` from `SEANCE_DIST_DIR`, default `.next`; the harness uses `.next-e2e`, git-ignored), so the e2e run never overwrites the deployable build.
6. A test SHALL prove 13.4: it reads the production output when present and fails if it contains the fixture marker string `SEANCE_FIXTURE_01_MAIN`; the e2e build contains it.
7. THE CSP SHALL be unchanged and the fixture page SHALL pass the existing CSP spec (no violation).

### Requirement 14: Screenshot tests

**User Story:** As a maintainer, I want screenshots to catch layout regressions at five sizes.

#### Acceptance Criteria

1. A Playwright spec SHALL open the Fixture at 1440x900, 1024x768, 768x1024, 390x844 and 360x740 (the last two with `isMobile` and `hasTouch`), with timezone `UTC`, locale `en-US`, reduced motion, caret hidden, fonts loaded (`document.fonts.ready`), and assert `toHaveScreenshot` for each.
2. FOR 1440x900 a Figma comparison test SHALL use the Figma_Export as the baseline, with `maxDiffPixelRatio` set from the first measured run plus a margin and recorded in `design.md`; WHEN the Figma_Export file does not exist that test SHALL be skipped with the reason "Figma export missing" (it is a manual input). The spec SHALL mask the regions whose text colour is deliberately lifted (timestamps, the nick list footer, the away nick) and the caret. A baseline generated from the Client SHALL also exist for 1440x900, as for the other four sizes, so every size is always covered.
3. A scripted check at each size SHALL assert no horizontal overflow (Requirement 11.1) and, on failure, print the selectors of the elements whose right edge is beyond the viewport.
4. A scripted check on the touch sizes SHALL assert the 32x32 hit area of Requirement 11.6.
5. THE spec SHALL assert region geometry at 1440x900 with `boundingBox()` for the nine regions of Requirement 1 (±1 px).
6. THE baselines SHALL be stored under `apps/web/e2e/__screenshots__/<project>/` with a path template without a platform suffix, and `design.md` SHALL state the platform they were generated on and how to regenerate them.
7. `pnpm --filter @seance/web test:e2e` SHALL run the spec; screenshots are never required by `pnpm test`.

### Requirement 15: Manual check, docs and naming

**User Story:** As a reviewer, I want a repeatable side-by-side check and a clean record.

#### Acceptance Criteria

1. `tasks.md` SHALL list a manual side-by-side check against the Figma exports of frames 01, 02, 03 and 04 with the specific items to look at.
2. THE Client SHALL keep every security rule: no inline `style` markup (`static-safety.test.ts` stays green), CSP unchanged, no `innerHTML`, all text through `IrcText`.
3. THE trademarked client name forbidden by `product.md` SHALL NOT appear in any file this spec adds or changes, including this spec.
4. `docs/KIRO_USAGE.md` SHALL record the Kiro features used.
5. All text, comments and commit messages SHALL be English.
