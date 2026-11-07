# Implementation Plan: web-client-polish

## Overview

The plan first adds tokens and pure core pieces (modes, away, credits, selectors), then Store additions (lag, minimise, draft), then the UI from the outside in (title, menu, toolbar, MDI, switchbar, status bar, chat, nick list, WHOIS), and ends with e2e and a manual visual check. Each property test carries its design property ID (`P1` to `P8`) in its name. Verify per package (`pnpm --filter @seance/web typecheck`, `pnpm --filter @seance/web test`) because root turbo runs may time out here. Never delete a test to make it pass; change tests only where a requirement intentionally changes behaviour.

## Tasks

- [ ] 1. Tokens, icons and scrollbars
  - [ ] 1.1 Read the missing token values and add them to `@theme`
    - Run `get_node_info` through the Talk-to-Figma channel for `00 Style guide` (1:4830) and read: inactive gradient, link blue, timestamp dim, action purple, event green, tool grey, away grey, mention bar, switchbar button faces
    - Optionally call the Figma power `get_design_context` once for `01 Main` (1:1093) with the real file URL
    - Add the tokens to `app/globals.css`; add contrast pairs to `src/a11y/contrast.test.ts`
    - _Requirements: 16.2, 16.3_
  - [ ] 1.2 Add the `Icon` component and the Win95 scrollbar styles
    - Inline SVG icons: connect, options, channels, agents, logs, theme, status, hash, ghost (three nick colours plus grey)
    - One scrollbar block in `globals.css` (16 px, arrows, dithered track, raised thumb)
    - Test that each icon renders `aria-hidden` and no `style` attribute
    - _Requirements: 3.6, 15.1, 15.2, 17.1_

- [ ] 2. Core: modes, away, credits, selectors
  - [ ] 2.1 Track channel and user modes
    - Add `modes` to `Window`, `userModes` to `ClientState`; `reducer.modes.ts` for `324`, `221`, channel and user `MODE`; reset on reconnect
    - Unit tests for flags with and without arguments, malformed input
    - _Requirements: 8.1, 8.3, 8.4, 8.5, 8.6_
  - [ ] 2.2 Write property test for mode tracking
    - **Property 5: Mode tracking** (`P5 mode tracking matches reference model`)
    - **Validates: Requirements 8.1 to 8.5**
  - [ ] 2.3 Track away state
    - `reducer.away.ts` for `301`, `305`, `306`, inbound `AWAY`; action-style lines; `NICK` and `QUIT` bookkeeping; bounded null-prototype record
    - _Requirements: 9.1, 9.2, 9.3, 9.4_
  - [ ] 2.4 Write property test for away bookkeeping
    - **Property 7: Away bookkeeping** (`P7 away bookkeeping`, include prototype names)
    - **Validates: Requirements 9.1 to 9.3**
  - [ ] 2.5 Parse credits from `320` lines
    - `parseCreditsLine`, `credits` record (max 50), update in `reducer.whois.ts`
    - Unit tests with the runner format `credits: #dev 9.60 / total 12.00` and with garbage
    - _Requirements: 5.5, 5.6, 5.7_
  - [ ] 2.6 Write property test for the credits total
    - **Property 3: Credits total** (`P3 credits total`)
    - **Validates: Requirements 5.5 to 5.7**
  - [ ] 2.7 Add `Line.prefix` and the exorcised nicks
    - Reducer sets `prefix` on join, part, quit lines; `exorcised` list per window (max 20), removed on rejoin, dropped on own leave and reconnect
    - _Requirements: 10.3, 11.6, 11.7_
  - [ ] 2.8 Add the selectors
    - `titleOf`, `modeSuffix`, `statusCounts`, `creditsTotal`, `exorcismText` in `src/irc/selectors.ts`; export from `index.ts`
    - Unit tests for each; `tsconfig.core.json` must still pass (no DOM)
    - _Requirements: 1.2, 1.3, 1.4, 6.4, 11.2, 12.4_
  - [ ] 2.9 Write property tests for title, counts and exorcism text
    - **Property 1: Title derivation**, **Property 2: Status counts**, **Property 4: Exorcism text** (one file each)
    - **Validates: Requirements 1.2 to 1.5, 6.4, 11.1, 11.2, 12.4**
  - [ ] 2.10 Checkpoint: `pnpm --filter @seance/web typecheck` and `test` pass

- [ ] 3. Store: lag, minimise, draft, MODE on join
  - [ ] 3.1 Send `MODE <channel>` after own join and add the lag timer
    - `ReduceResult.pong`; 30 s `PING :seance-lag-<n>` with the injected timer; clear in `release`, `dispose`, `closeAfterQuit`, reconnect
    - Fake-timer tests: pairing, ignored foreign `PONG`, stop on dispose
    - _Requirements: 6.5, 8.2, 17.4, 17.5_
  - [ ] 3.2 Write property test for lag pairing
    - **Property 6: Lag pairing** (`P6 lag pairing`)
    - **Validates: Requirements 6.5**
  - [ ] 3.3 Add minimise, restore and the Input_Line draft
    - `ui.minimised`, `minimiseWindow`, `restoreWindow`, `insertCommand`; prune on close; survive reconnect
    - Tests for next-window activation after minimising the active window
    - _Requirements: 4.3, 4.4, 4.7, 2.5_

- [ ] 4. Chrome: title bar, menu bar, toolbar
  - [ ] 4.1 `TitleBar` and document title
    - _Requirements: 1.1 to 1.8_
  - [ ] 4.2 Rewrite `MenuBar` with `MenuPopup`
    - Seven menus, items per R2.3, disabled items, roving tabindex, mnemonics, Escape, outside click
    - Tests: keyboard navigation, disabled items inert, Window menu lists windows, items prefill the Input_Line
    - _Requirements: 2.1 to 2.8_
  - [ ] 4.3 Rebuild `Toolbar`
    - Icons, separators, theme label, disabled buttons, toolbar keyboard navigation
    - _Requirements: 3.1 to 3.6_
  - [ ] 4.4 Checkpoint: typecheck, test, lint

- [ ] 5. MDI, switchbar, status bar, topic bar
  - [ ] 5.1 Turn `WindowFrame` into `MdiChild` with child title bar
    - Titles per R4.2; status close disabled
    - _Requirements: 4.1, 4.2, 4.5, 4.6, 4.9_
  - [ ] 5.2 Add `MinimisedTray` and `MinimisedBar`
    - _Requirements: 4.3, 4.4, 4.8_
  - [ ] 5.3 Rebuild `Switchbar` with `CreditsCounter`
    - _Requirements: 5.1 to 5.4, 5.8_
  - [ ] 5.4 Rebuild `StatusBar`
    - _Requirements: 6.1 to 6.3, 6.6, 6.7_
  - [ ] 5.5 Rebuild `TopicBar`
    - _Requirements: 7.1 to 7.3_

- [ ] 6. Chat surfaces
  - [ ] 6.1 Update `ChatLine`: `***` events, `(user@host)`, `<@nick>` prefix, colours, mention bar, bottom anchoring
    - Update `classify.ts` markers; change the tests that expect `[exorcised]`
    - _Requirements: 10.1 to 10.8_
  - [ ] 6.2 Exorcism line
    - Text via `exorcismText`, struck agent nick, bold orange `exorcised`, ghost glyph with `role="img"`, purple bar
    - _Requirements: 11.1 to 11.5_
  - [ ] 6.3 Write property test for the chat prefix
    - **Property 8: Chat prefix** (`P8 chat prefix`)
    - **Validates: Requirements 10.2**
  - [ ] 6.4 Rebuild `NickList`
    - Agent icons, away look, footer `N users · N agents`, exorcised rows
    - _Requirements: 12.1 to 12.5, 11.6_
  - [ ] 6.5 Replace `WhoisBlock` with `WhoisLines`
    - Update `reducer.whois.test.ts` and `WhoisBlock.test.tsx` to the line format
    - _Requirements: 13.1 to 13.5_
  - [ ] 6.6 Status window formats
    - Numeric prefix, bold MOTD heading, `-server-` notices, pre-formatted MOTD, connection lines from the Store
    - _Requirements: 14.1 to 14.4_
  - [ ] 6.7 Checkpoint: typecheck, test, lint, `static-safety` and `boundaries` tests pass

- [ ] 7. End-to-end and visual verification
  - [ ] 7.1 Extend the e2e tests
    - Cases of R18.1 in `e2e/flow.spec.ts` and `e2e/csp.spec.ts`
    - _Requirements: 17.1, 18.1_
  - [ ] 7.2 Visual check with the Playwright MCP (manual)
    - Production build, 1440×900 screenshots of the four frames, compare with the exports, note the differences here
    - _Requirements: 18.2, 18.3_
  - [ ] 7.3 Documentation and usage log
    - Update `apps/web/README.md`, `docs/KIRO_USAGE.md` (Figma sources used and the skipped Figma power call)
    - _Requirements: 18.4_
  - [ ] 7.4 Final checkpoint
    - `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm --filter @seance/web test:e2e`

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "2.3", "2.5"] },
    { "id": 1, "tasks": ["1.2", "2.2", "2.4", "2.6", "2.7"] },
    { "id": 2, "tasks": ["2.8", "3.1", "3.3"] },
    { "id": 3, "tasks": ["2.9", "3.2", "4.1", "4.2", "4.3"] },
    { "id": 4, "tasks": ["5.1", "5.3", "5.4", "5.5", "6.1"] },
    { "id": 5, "tasks": ["5.2", "6.2", "6.4", "6.5", "6.6"] },
    { "id": 6, "tasks": ["6.3", "7.1"] },
    { "id": 7, "tasks": ["7.2", "7.3", "7.4"] }
  ]
}
```
