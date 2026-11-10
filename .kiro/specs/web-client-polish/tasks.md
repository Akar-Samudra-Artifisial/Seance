# Implementation Plan: web-client-polish

## Overview

The plan first adds tokens and pure core pieces (modes, away, credits, selectors), then Store additions (lag, minimise, draft), then the UI from the outside in (title, menu, toolbar, MDI, switchbar, status bar, chat, nick list, WHOIS), and ends with e2e and a manual visual check. Each property test carries its design property ID (`P1` to `P8`) in its name. Verify per package (`pnpm --filter @seance/web typecheck`, `pnpm --filter @seance/web test`) because root turbo runs may time out here. Never delete a test to make it pass; change tests only where a requirement intentionally changes behaviour.

## Tasks

- [x] 1. Tokens, icons and scrollbars
  - [x] 1.1 Read the missing token values and add them to `@theme`
    - Run `get_node_info` through the Talk-to-Figma channel for `00 Style guide` (1:4830) and read: inactive gradient, link blue, timestamp dim, action purple, event green, tool grey, away grey, mention bar, switchbar button faces
    - Optionally call the Figma power `get_design_context` once for `01 Main` (1:1093) with the real file URL
    - Add the tokens to `app/globals.css`; add contrast pairs to `src/a11y/contrast.test.ts`
    - _Requirements: 16.2, 16.3_
  - [x] 1.2 Add the `Icon` component and the Win95 scrollbar styles
    - Inline SVG icons: connect, options, channels, agents, logs, theme, status, hash, ghost (three nick colours plus grey)
    - One scrollbar block in `globals.css` (16 px, arrows, dithered track, raised thumb)
    - Test that each icon renders `aria-hidden` and no `style` attribute
    - _Requirements: 3.6, 15.1, 15.2, 17.1_

  - [x] 1.3 Apply the font tokens to chrome and chat surfaces
    - Win95_Sans (`font-chrome`) for titles, menus, buttons, switchbar and status bar; IBM Plex Mono for chat, nick list, topic bar, input and credits; VT323 only for display titles
    - Test that no component class list sets a font size below 11 px (extend `static-safety.test.ts`)
    - _Requirements: 16.1, 16.4_

- [x] 2. Core: modes, away, credits, selectors
  - [x] 2.1 Track channel and user modes
    - Add `modes` to `Window`, `userModes` to `ClientState`; `reducer.modes.ts` for `324`, `221`, channel and user `MODE`; reset on reconnect
    - Unit tests for flags with and without arguments, malformed input
    - _Requirements: 8.1, 8.3, 8.4, 8.5, 8.6_
  - [x] 2.2 Write property test for mode tracking
    - **Property 5: Mode tracking** (`P5 mode tracking matches reference model`)
    - **Validates: Requirements 8.1 to 8.5**
  - [x] 2.3 Track away state
    - `reducer.away.ts` for `301`, `305`, `306`, inbound `AWAY`; action-style lines; `NICK` and `QUIT` bookkeeping; bounded null-prototype record
    - _Requirements: 9.1, 9.2, 9.3, 9.4_
  - [x] 2.4 Write property test for away bookkeeping
    - **Property 7: Away bookkeeping** (`P7 away bookkeeping`, include prototype names)
    - **Validates: Requirements 9.1 to 9.3**
  - [x] 2.5 Parse credits from `320` lines
    - `parseCreditsLine`, `credits` record (max 50), update in `reducer.whois.ts`
    - Unit tests with the runner format `credits: #dev 9.60 / total 12.00` and with garbage
    - _Requirements: 5.5, 5.6, 5.7_
  - [x] 2.6 Write property test for the credits total
    - **Property 3: Credits total** (`P3 credits total`)
    - **Validates: Requirements 5.5 to 5.7**
  - [x] 2.7 Add `Line.prefix` and the exorcised nicks
    - Reducer sets `prefix` on join, part, quit lines; `exorcised` list per window (max 20), removed on rejoin, dropped on own leave and reconnect
    - _Requirements: 10.3, 11.6, 11.7_
  - [x] 2.8 Add the selectors
    - `titleOf`, `modeSuffix`, `statusCounts`, `creditsTotal`, `exorcismText` in `src/irc/selectors.ts`; export from `index.ts` (`creditsTotal` was later replaced by `creditsForActive`, web-client-extras task 10.23)
    - Unit tests for each; `tsconfig.core.json` must still pass (no DOM)
    - _Requirements: 1.2, 1.3, 1.4, 6.4, 11.2, 12.4_
  - [x] 2.9 Write property tests for title, counts and exorcism text
    - **Property 1: Title derivation**, **Property 2: Status counts**, **Property 4: Exorcism text** (one file each)
    - **Validates: Requirements 1.2 to 1.5, 6.4, 11.1, 11.2, 12.4**
  - [x] 2.10 Checkpoint: `pnpm --filter @seance/web typecheck` and `test` pass

- [x] 3. Store: lag, minimise, draft, MODE on join
  - [x] 3.1 Send `MODE <channel>` after own join and add the lag timer
    - `ReduceResult.pong`; 30 s `PING :seance-lag-<n>` with the injected timer; clear in `release`, `dispose`, `closeAfterQuit`, reconnect
    - Fake-timer tests: pairing, ignored foreign `PONG`, stop on dispose
    - _Requirements: 6.5, 8.2, 17.4, 17.5_
  - [x] 3.2 Write property test for lag pairing
    - **Property 6: Lag pairing** (`P6 lag pairing`)
    - **Validates: Requirements 6.5**
  - [x] 3.3 Add minimise, restore and the Input_Line draft
    - `ui.minimised`, `minimiseWindow`, `restoreWindow`, `insertCommand`; prune on close; survive reconnect
    - Tests for next-window activation after minimising the active window
    - _Requirements: 4.3, 4.4, 4.7, 2.5_

- [x] 4. Chrome: title bar, menu bar, toolbar
  - [x] 4.1 `TitleBar` and document title
    - _Requirements: 1.1 to 1.8_
  - [x] 4.2 Rewrite `MenuBar` with `MenuPopup`
    - Seven menus, items per R2.3, disabled items, roving tabindex, mnemonics, Escape, outside click
    - Tests: keyboard navigation, disabled items inert, Window menu lists windows, items prefill the Input_Line
    - _Requirements: 2.1 to 2.8_
  - [x] 4.3 Rebuild `Toolbar`
    - Icons, separators, theme label, disabled buttons, toolbar keyboard navigation
    - _Requirements: 3.1 to 3.6_
  - [x] 4.4 Checkpoint: typecheck, test, lint

- [x] 5. MDI, switchbar, status bar, topic bar
  - [x] 5.1 Turn `WindowFrame` into `MdiChild` with child title bar
    - Titles per R4.2; status close disabled
    - _Requirements: 4.1, 4.2, 4.5, 4.6, 4.9_
  - [x] 5.2 Add `MinimisedTray` and `MinimisedBar`
    - _Requirements: 4.3, 4.4, 4.8_
  - [x] 5.3 Rebuild `Switchbar` with `CreditsCounter`
    - _Requirements: 5.1 to 5.4, 5.8_
  - [x] 5.4 Rebuild `StatusBar`
    - _Requirements: 6.1 to 6.3, 6.6, 6.7_
  - [x] 5.5 Rebuild `TopicBar`
    - _Requirements: 7.1 to 7.3_

- [x] 6. Chat surfaces
  - [x] 6.1 Update `ChatLine`: `***` events, `(user@host)`, `<@nick>` prefix, colours, mention bar, bottom anchoring
    - Add the `--- Session start: <date time>` line once per connection to the Status_Window and each new Channel_Window
    - Keep `role="log"`, `aria-live="polite"` and keyboard scrolling (`PageUp`, `PageDown`, arrows) on the Chat_Buffer; add a test for each
    - Update `classify.ts` markers; change the tests that expect `[exorcised]`
    - _Requirements: 10.1 to 10.8, 15.3_
  - [x] 6.2 Exorcism line
    - Text via `exorcismText`, struck agent nick, bold orange `exorcised`, ghost glyph with `role="img"`, purple bar
    - _Requirements: 11.1 to 11.5_
  - [x] 6.3 Write property test for the chat prefix
    - **Property 8: Chat prefix** (`P8 chat prefix`)
    - **Validates: Requirements 10.2**
  - [x] 6.4 Rebuild `NickList`
    - Agent icons, away look, footer `N users · N agents`, exorcised rows
    - _Requirements: 12.1 to 12.5, 11.6_
  - [x] 6.5 Replace `WhoisBlock` with `WhoisLines`
    - Update `reducer.whois.test.ts` and `WhoisBlock.test.tsx` to the line format
    - _Requirements: 13.1 to 13.5_
  - [x] 6.6 Status window formats
    - Numeric prefix, bold MOTD heading, `-server-` notices, pre-formatted MOTD (spaces preserved, no wrap inside a line)
    - Store writes `* Connecting to <host> (<port>)` and `*** Connected to <host> (TLS)` (TLS only for `wss:`); test both schemes
    - _Requirements: 14.1 to 14.4, 6.2_
  - [x] 6.7 Checkpoint: typecheck, test, lint, `static-safety` and `boundaries` tests pass
    - List every `web-client-basic` test changed by this spec (kick marker, WHOIS block, menu items, status bar) in the commit message; none may be deleted
    - _Requirements: 17.6_

- [x] 7. End-to-end and visual verification
  - [x] 7.1 Extend the e2e tests
    - Cases of R18.1 in `e2e/flow.spec.ts`: window titles for Status and a channel, the seven menu names, a disabled menu item, minimise and restore, status bar text after registration, Credits_Counter after a WHOIS of the fake agent, the exorcism line with and without a reason
    - `e2e/csp.spec.ts` keeps its CSP and security-header assertions and must still pass with the new chrome (no inline `style`)
    - _Requirements: 17.1, 18.1_
  - [x] 7.2 Visual check with the Playwright MCP (manual)
    - Production build, 1440×900 screenshots of the four frames, compare with the exports, note the differences here
    - _Requirements: 18.2, 18.3_
    - Result (Playwright MCP against the e2e Fake_Agent stack, `next build` production, Chromium 1440×900; Talk-to-Figma channel `8p9g0i9k`, `export_node_as_image` PNG @1x of 1:1093, 1:2153, 1:4655, 1:2947). Screenshots were kept in a git-ignored temp dir and deleted. Differences, by area:
      - Data, not UI (fixtures): the Figma frames show a rich scripted session (topic, `+mnt`, three agents, `lag 0.12s`, TLS MOTD with ASCII pumpkin). The live stack has one Fake_Agent, no topic and `seance-ircd-0.1`, so line content, topic bar text, `N agents · N away · N ops` counts and the MOTD art differ by design. Not compared further.
      - Layout, Main (01): the Figma Channel_Window is inset with its title bar hidden (the child bar sits in the tray); the client shows the child title bar `# #dev` with min/max/close inside the MDI area. The Figma Status child is a titled tray button at the bottom; the client shows only a switchbar button. Figma switchbar has 4 buttons (Status, two channels, query) at 160 px; the client shows only open windows, same 160 px width. Nick list width (~180 px) and the `N users · N agents` footer match.
      - Layout, Status (02): Figma input line sits at y≈808 with a visible Chat_Buffer scrollbar (16 px, arrows) because content overflows; the client's buffer was not overflowing, so no scrollbar was visible. The client's Status MOTD is not centred on the pumpkin art (fixture MOTD has no art).
      - Colours: Ghost background `#0b0b0f`, text `#d8d4c8`, orange human nick, blue `coder`, green events and purple `*` lines match the exports by eye; computed styles confirm `rgb(11,11,15)` and `rgb(216,212,200)` for the buffer. Toolbar icons are grey outlines in the client (including enabled ones such as Agents and Status) and coloured in Figma (yellow bolt, ghost, document). Switchbar inactive button text is blue-tinted in the client (`Status` while another window is active) where Figma uses black. Away and mention highlight rows could not be produced with the Fake_Agent and were not compared.
      - Fonts: computed styles confirm IBM Plex Mono 15 px in buffer and input, Arimo for chrome. Rendered chat and chrome text look the same size as the exports. VT323 titles are not used on these four frames.
      - Spacing: line height (21 px), timestamp gutter match by eye (21 px line pitch in both). Other metrics (toolbar height, bevel widths) were not measured.
      - Kick (03): the client prints `*** coder has been exorcised by bayu (scope creep)` with struck nick, orange bold `exorcised`, ghost glyph and purple bar like the export. The nick list shows `coder` struck in grey without the ghost glyph; Figma keeps the struck nick in dim blue with a ghost glyph.
      - Whois (04, no dialog): lines use the coloured nick and `is`/`on`/`using`/`model:`/`tools:`/`status:`/`credits:` format as in Figma. Client shows `shell(sandbox)` and `credits: #dev 0.00 / total 0.00` (fixture values); Figma has `shell (op only)` and session lines (`session:`), which the Ircd does not send. A literal `12` stays in front of the Fake_Agent reply (`12The veil is thin tonight.`): the `\x0312` colour is applied but the digits are shown. This looks like a rendering bug in the IRC colour parsing for `\x03NN` followed by a letter, not a design difference; worth a separate test.
      - Console: one 404 for `/favicon.ico`. No CSP or other errors.
      - Not done: pixel diffs (no overlay tool); frame 04's Options dialog was out of scope as instructed.
  - [x] 7.3 Documentation and usage log
    - Update `apps/web/README.md`, `docs/KIRO_USAGE.md` (Figma sources used and the skipped Figma power call)
    - _Requirements: 18.4_
  - [x] 7.4 Final checkpoint
    - `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm --filter @seance/web test:e2e`

## Notes

- Dev setup (from manual browser testing): the default Ircd WebSocket port is 6680 because browsers block 6665-6669.
- `pnpm --filter @seance/web dev` runs `next dev --webpack`. Its dev CSP uses `style-src 'self' 'unsafe-inline'` without a nonce; production keeps the nonce.
- The e2e stack picks free ports.
- Frames are compared in the production build, so the dev CSP does not affect the visual check.
- Verify per package (`pnpm --filter @seance/web typecheck`, `pnpm --filter @seance/web test`) because root turbo runs may time out here.
- Never delete a test to make it pass; change tests only where a requirement intentionally changes behaviour.
- Each property test carries its design property ID (`P1` to `P8`) in its name.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "2.3", "2.5"] },
    { "id": 1, "tasks": ["1.2", "1.3", "2.2", "2.4", "2.6", "2.7"] },
    { "id": 2, "tasks": ["2.8", "3.1", "3.3"] },
    { "id": 3, "tasks": ["2.9", "3.2", "4.1", "4.2", "4.3"] },
    { "id": 4, "tasks": ["5.1", "5.3", "5.4", "5.5", "6.1"] },
    { "id": 5, "tasks": ["5.2", "6.2", "6.4", "6.5", "6.6"] },
    { "id": 6, "tasks": ["6.3", "7.1"] },
    { "id": 7, "tasks": ["7.2", "7.3", "7.4"] }
  ]
}
```
