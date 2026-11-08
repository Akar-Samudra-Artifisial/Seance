# Implementation Plan: web-client-extras

## Overview

Order: the runner label first (independent of the web work), then the pure channel-list core, the store and dialogs, the theme, the shortcut registry, the explained-disabled controls, the Playwright baseline, and the docs and final checks. Each property test carries its design ID (`P1` to `P4`) in its name. Verify per package (`pnpm --filter @seance/web typecheck`, `pnpm --filter @seance/web exec vitest run`, `pnpm --filter @seance/runner exec vitest run`); root turbo runs may time out here. Rebuild the runner (`pnpm --filter @seance/runner build`) before ircd tests that import `@seance/runner`. `apps/ircd` source is not changed. Never delete a test to make it pass; change a test only for an intended behaviour change, with a comment. The Figma export of frame 06 is a manual step (task 7.2) and blocks nothing.

## Tasks

- [x] 1. Runner WHOIS tools label
  - [x] 1.1 Add `apps/runner/src/whois/tools-label.ts` with `toolsLabel(raw, mode)`
    - Rewrites the `shell(...)` token (or a bare `shell`) to `shell(host)` for `none` and `shell(sandbox)` for `podman`; leaves other text, including `shellcheck`, alone
    - _Requirements: 6.1, 6.2_
  - [x] 1.2 Add `sandboxMode` to `InviteControllerDeps`, apply `toolsLabel` where the profile is registered in the Whois_Snapshot, and pass `sandboxConfig.mode` from `runner.ts`
    - _Requirements: 6.2_
  - [x] 1.3 Write tests
    - `apps/runner/test/tools-label.test.ts` for both modes, a bare token and unrelated text
    - Update `apps/ircd/test/runner/credits.integration.test.ts` to expect `tools: fs, git, shell(host)` (sandbox none), with a comment
    - _Requirements: 6.1_

- [x] 2. Channel list core (pure)
  - [x] 2.1 Add `ListRow` and `ChannelList` types and the `LIST_*` limits to `irc/types.ts`; add `list?` to `ClientState`
    - _Requirements: 1.3, 1.4_
  - [x] 2.2 Add `irc/channel-list.ts`: `parseListRow`, `filterRows`, `sortRows`, `nextSort`, `batchNames`, `summarise`
    - Row validation (name 1 to 200 characters without spaces or commas, count `^\d{1,9}$`, topic clipped to 512); filter on `irc_lower(plain(...))`; unknown agent counts pass Min agents and sort last in both directions; `batchNames` measures UTF-8 bytes by hand because the core has no `TextEncoder`
    - _Requirements: 1.4, 1.6, 1.7, 2.2, 2.3_
  - [x] 2.3 Add `irc/reducer.list.ts`: `startList`, `failList`, `clearList`, `onListReply`, `countListNames`, `finishListNames`; route 321, 322, 323, 353 and 366 in `reducer.ts`; clear `list` in `resetForReconnect`
    - 321, 322 and 323 go to the list only while `status === "loading"`; otherwise they keep landing in the Status window
    - 323 fills agent counts from joined windows and returns `NAMES` batches in `send`; 353 and 366 for requested channels are counted and finish the row
    - _Requirements: 1.3, 1.4, 1.10, 2.1, 2.2, 2.4_
  - [x] 2.4 Write tests
    - `channel-list.test.ts`: `parseListRow` table, filter, sort, `nextSort` cycle, `summarise`
    - **Property 1: Filter is a subset and idempotent** (`P1 filter is a subset and idempotent`)
    - **Property 2: Sort is a permutation** (`P2 sort is a permutation`)
    - **Property 4: Batches stay within the byte limit and cover every channel in order** (`P4 batches stay within the byte limit`, multi-byte names)
    - `reducer.list.test.ts`: collects while loading, old Status behaviour when not loading, late 322 ignored, invalid rows dropped, cap, joined and pending counts, 366 finish, unrelated 353 and 366 ignored, `failList`, reconnect reset
    - **Property 3: The row cap never exceeds 500** (`P3 the row cap holds for any number of replies`)
    - Existing `reducer.route.test.ts` and `reducer.whois.test.ts` stay unchanged and green
    - **Validates: Requirements 1.3, 1.4, 1.6, 1.7, 2.2 to 2.4**

- [x] 3. Store actions and dialogs
  - [x] 3.1 Add `channelListOpen`, `shortcutsOpen` and `theme` to `UiState`; add `openChannelList`, `refreshChannelList`, `closeChannelList`, `joinFromList`, `openShortcuts`, `closeShortcuts`, `setTheme`, `toggleTheme` to the store
    - `LIST` is sent only when registered; a 15 s timer (`deps.setTimeout`) marks a still-loading list failed; the timer is stopped on refresh, close, disconnect, quit and `dispose`; a new connection drops the old list; `joinFromList` submits the join command and closes
    - _Requirements: 1.1, 1.5, 1.8, 1.10_
  - [x] 3.2 Add `components/Dialog.tsx` in the style of Figma frame 04
    - Navy gradient title bar, 16x14 `?` and `X` buttons, `role="dialog" aria-modal`, Tab trap, Esc closes, focus returns to the opener
    - _Requirements: 1.9, 4.1_
  - [x] 3.3 Add `components/ChannelListDialog.tsx` (Figma frame 05)
    - Match text, Min agents, Hide channels without a topic, Apply filter; sortable header buttons with `aria-sort`; roving-tabindex rows; Enter and double-click join; Loading, No channels and failure text; footer with counts and listed time; Join, Refresh, Close; `?` toggles a keyboard hint; topics through `plain()`
    - _Requirements: 1.2, 1.5 to 1.9, 2.3_
  - [x] 3.4 Enable the toolbar Channel list button while registered, add Commands, Channel list, and render `ChannelListDialog` and `ShortcutsDialog` in `Shell`
    - _Requirements: 1.1_
  - [x] 3.5 Write tests
    - `store/extras.test.ts`: not registered is a no-op, `LIST` sent, timeout, refresh clears the old timer, join, close on disconnect, list dropped on a new connection
    - `components/extras.test.tsx`: Loading until 323, rows and plain topics, a dash for unknown counts, empty state, filter on Apply only, sort with `aria-sort`, Enter and double-click join, Join explained while nothing is selected, Esc, Refresh, `?` hint
    - **Validates: Requirements 1.1 to 1.10**

- [x] 4. Theme
  - [x] 4.1 Add the Classic token block under `html[data-theme="classic"]` in `app/globals.css` and the `--color-mention-fill` token; use `bg-mention-fill` for mention rows in `ChatLine.tsx`
    - Values from Figma frame 06; colours that fail 4.5:1 are lifted and commented, as listed in `design.md`; no inline style, CSP and `proxy.ts` unchanged
    - _Requirements: 3.2, 3.4_
  - [x] 4.2 Add `--classic` mode to `scripts/irc-palette.mjs` and write the Classic `--color-irc-fg-N` values
    - _Requirements: 3.4_
  - [x] 4.3 Add `THEME_KEY`, `isTheme`, `readTheme` and `writeTheme` to `store/storage.ts`; `ui.theme` starts as Ghost and `loadStoredTheme()` applies the stored name; add `components/ThemeSync.tsx` (calls `loadStoredTheme()` and sets `data-theme`, both in layout effects, so hydration matches the server render; review finding 7)
    - A failed write leaves the theme set and adds an error line to the Status window
    - _Requirements: 3.1, 3.3_
  - [x] 4.4 Toolbar: Toggle theme button and `Theme: Ghost` or `Theme: Classic` label; View menu: checked Ghost theme and Classic theme items
    - _Requirements: 3.1_
  - [x] 4.5 Let the Playwright fixture read the stored theme (`themeOnlyBackend` in `fixtures/shell.tsx`)
    - _Requirements: 3.5_
  - [x] 4.6 Write tests
    - `a11y/contrast.test.ts`: parse the Ghost set apart from the Classic block; every text token on white and on the mention fill; accent on its 20 % fill; mention bar 3:1; focus ring 3:1; selected row
    - `store/extras.test.ts`: default Ghost, invalid stored values ignored, stored Classic read, toggle stores only the name, failed write reported
    - `Toolbar.test.tsx`: toggle changes theme and label
    - **Validates: Requirements 3.1 to 3.4**

- [x] 5. Keyboard shortcuts
  - [x] 5.1 Add `shortcuts/shortcuts.ts`: `MENU_DEFS`, `INPUT_KEYS`, `CLOSE_KEY`, `windowSwitchIndex`, `menuIndexForMnemonic`, `mnemonicOf`, `pasteNote`, `SHORTCUTS`
    - _Requirements: 4.2, 4.3_
  - [x] 5.2 Use the module in the real handlers: `Shell` (Alt+digit), `MenuBar` (menus built from `MENU_DEFS`, mnemonics, `aria-keyshortcuts`), `InputLine` (Tab, ArrowUp, ArrowDown), `Dialog` (Esc)
    - _Requirements: 4.2_
  - [x] 5.3 Add `components/ShortcutsDialog.tsx` and enable Help, Keyboard shortcuts
    - Rows generated from `SHORTCUTS` by group; paste note from `PASTE_MAX_LINES` and `PASTE_INTERVAL_MS`
    - _Requirements: 4.1, 4.3_
  - [x] 5.4 Write drift tests in `components/extras.test.tsx`
    - One dialog row per registry entry, paste note contains both constants, Esc closes
    - `windowSwitchIndex` matches Alt+1 to 9 only; every menu button announces the registry mnemonic; Alt+H opens Help; the Input_Line reacts to the registry keys
    - **Validates: Requirements 4.1 to 4.3**

- [x] 6. Explained disabled controls
  - [x] 6.1 Add `reason` to `MenuEntry` and render it as `title` and `aria-description` in `MenuPopup`; give every disabled entry in `MenuBar` a specific reason
    - _Requirements: 5.1, 5.2, 5.4_
  - [x] 6.2 Add `description` to `CaptionButton`; use it for the title-bar minimise and maximise (browser tab), the title-bar close when not connected (now inert), the menu-bar restore and close buttons
    - _Requirements: 5.1, 5.2_
  - [x] 6.3 Toolbar: `reason` on Connect, Options, Channel list and Agents (disabled outside a channel window); tooltip is the label, a colon and the reason
    - _Requirements: 5.1, 5.2, 5.4_
  - [x] 6.4 Write tests
    - `components/extras.test.tsx`: no unexplained disabled control in six client states (fresh, connecting, status, channel, two channels, dropped) across title bar, menu bar, every opened menu and toolbar; the named reasons; an explained control stays inert
    - `Toolbar.test.tsx`: update the title and disabled-list expectations for the intended change, with comments
    - **Validates: Requirements 5.1 to 5.4**

- [x] 7. Playwright
  - [x] 7.1 Refactor the Figma comparison of `e2e/pixel.spec.ts` into `compareWithFigma`; add the Frame_06 Classic fixture tests: token set applied, app baseline `06-classic.png` at five sizes, no CSP violation, frame 06 comparison that skips without its export
    - _Requirements: 3.5_
  - [x] 7.2 **Manual step (blocks nothing):** save the Figma export of frame 06 as `apps/web/e2e/figma/06-classic-1440x900.png`, run the comparison with `FIGMA_MAX_DIFF_RATIO_06` set to 0, read the measured ratio from the failure and set the limit to measured plus 20 % (design Open Point 1)
    - Done 2026-11-08: export from the Figma REST API (node 1:1623, 1440x900); measured 16,827 of 1,296,000 pixels (0.01298), limit 0.0156
    - _Requirements: 3.5_

- [x] 8. Docs and final checks
  - [x] 8.1 Update `README.md` and `apps/web/README.md` (disabled items, channel list, themes, shortcuts, frame 06 baseline)
    - _Requirements: 7.3_
  - [x] 8.2 Record the Figma calls and add the usage entries to `docs/KIRO_USAGE.md`
    - _Requirements: 7.3_
  - [x] 8.3 Run `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test --force` and `pnpm --filter @seance/web test:e2e`; revert `apps/web/next-env.d.ts`
    - Confirm the word that names the trademarked client appears in none of the touched files
    - _Requirements: 7.1, 7.2_

## Notes

- Every test sub-task is a required step in this plan; design properties P1 to P4 are all in 2.4.
- Task 7.2 needed the user to export frame 06 from Figma (the tools cannot write the PNG); the export now exists and the frame 06 comparison runs.
- Tasks 4.1 and 4.2 produce the lifted Classic colours; each lift is commented in `globals.css` and tabled in `design.md`.
- Root `pnpm typecheck` and `pnpm test` may time out under turbo; per-package runs are acceptable. Tests use fake timers or injected `setTimeout` and bind sockets to port 0.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "4.1", "5.1", "6.1", "6.2"] },
    { "id": 1, "tasks": ["1.2", "2.2", "4.2", "4.3", "5.2", "6.3"] },
    { "id": 2, "tasks": ["1.3", "2.3", "3.2", "4.5", "5.3"] },
    { "id": 3, "tasks": ["2.4", "3.1", "4.4"] },
    { "id": 4, "tasks": ["3.3", "6.4"] },
    { "id": 5, "tasks": ["3.4", "4.6", "5.4"] },
    { "id": 6, "tasks": ["3.5", "7.1"] },
    { "id": 7, "tasks": ["8.1", "8.2"] },
    { "id": 8, "tasks": ["8.3"] },
    { "id": 9, "tasks": ["7.2"] }
  ]
}
```
